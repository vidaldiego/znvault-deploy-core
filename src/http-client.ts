// Path: src/http-client.ts
// HTTP/HTTPS client for agent communication

import type { DeployResult, AgentPostResult, DeploymentStatusResponse } from './types.js';
import {
  AGENT_TIMEOUT_MS,
  DEPLOYMENT_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_MAX_WAIT_MS,
} from './constants.js';
import { getErrorMessage } from './utils/error.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Agent as UndiciAgent } from 'undici';

/** Stable wire name used to correlate binary deployment requests. */
export const DEPLOYMENT_ID_HEADER = 'x-znvault-deployment-id';

/** Create an opaque identifier for exactly one deployment mutation. */
export function createDeploymentId(): string {
  return randomUUID();
}

/**
 * TLS configuration for HTTPS connections
 */
export interface TLSOptions {
  /** Enable TLS verification (default: true) */
  verify?: boolean;
  /** Path to CA certificate file (PEM format) */
  caCertPath?: string;
  /** Inline CA certificate (PEM format) */
  caCert?: string;
}

/**
 * Per-request authorization for the agent's local control plane.
 *
 * Keep the token in memory only. Callers are responsible for loading it from
 * a private file and must never put it in a URL, process argument, environment
 * variable, log field, or persisted deploy configuration.
 */
export interface AgentRequestAuth {
  bearerToken: string;
}

/**
 * Connection information for a host
 */
export interface ConnectionInfo {
  /** Host address */
  host: string;
  /** Whether TLS is being used */
  tls: boolean;
  /** Whether TLS certificate is verified (only relevant if tls=true) */
  verified: boolean;
  /** Effective port being used */
  port: number;
  /** Full plugin URL */
  pluginUrl: string;
}

/**
 * Global TLS options for all HTTPS requests in this CLI session.
 * This is intentionally global because the CLI runs as a single process
 * and TLS configuration should be consistent across all agent requests.
 */
let globalTLSOptions: TLSOptions = { verify: true };

/**
 * Cached Undici dispatcher for reuse across requests
 */
let cachedUndiciAgent: { key: string; agent: UndiciAgent } | null = null;

function clearCachedUndiciAgent(): void {
  const cached = cachedUndiciAgent;
  cachedUndiciAgent = null;
  if (cached) {
    void cached.agent.destroy().catch(() => undefined);
  }
}

/**
 * Configure TLS options for all HTTPS requests.
 * Call this once at startup, before making any HTTPS requests.
 */
export function configureTLS(options: TLSOptions): void {
  globalTLSOptions = { ...globalTLSOptions, ...options };
  clearCachedUndiciAgent();
}

/**
 * Get the current TLS configuration (for debugging/display)
 */
export function getTLSConfig(): Readonly<TLSOptions> {
  return { ...globalTLSOptions };
}

/**
 * Get or create a cached Undici dispatcher for the requested TLS policy.
 */
function getUndiciAgent(tlsOptions: TLSOptions): UndiciAgent | undefined {
  const needsCustomAgent = tlsOptions.verify === false ||
    tlsOptions.caCertPath !== undefined ||
    tlsOptions.caCert !== undefined;

  if (!needsCustomAgent) {
    return undefined;
  }

  const ca = tlsOptions.caCert ??
    (tlsOptions.caCertPath ? readFileSync(tlsOptions.caCertPath, 'utf-8') : undefined);
  const key = JSON.stringify([tlsOptions.verify !== false, ca]);
  if (cachedUndiciAgent?.key === key) {
    return cachedUndiciAgent.agent;
  }

  clearCachedUndiciAgent();
  const agent = new UndiciAgent({
    connect: {
      rejectUnauthorized: tlsOptions.verify !== false,
      ...(ca ? { ca } : {}),
    },
  });
  cachedUndiciAgent = { key, agent };
  return agent;
}

/**
 * Get fetch options with TLS configuration for HTTPS URLs
 */
function getFetchOptions(
  url: string,
  baseOptions: RequestInit,
  tlsOptions: TLSOptions = globalTLSOptions,
): RequestInit {
  // Only apply TLS options for HTTPS URLs
  if (!url.startsWith('https://')) {
    return baseOptions;
  }

  const options: RequestInit = { ...baseOptions };

  // Note: Node.js native fetch doesn't support custom TLS options directly.
  // We use undici's dispatcher option which is compatible with Node 18+

  // For Bun runtime, TLS options are handled differently
  if (typeof process !== 'undefined' && process.versions?.bun) {
    // Bun uses native TLS options
    if (tlsOptions.verify === false) {
      (options as Record<string, unknown>).tls = { rejectUnauthorized: false };
    } else if (tlsOptions.caCertPath || tlsOptions.caCert) {
      const ca = tlsOptions.caCert ??
        (tlsOptions.caCertPath ? readFileSync(tlsOptions.caCertPath, 'utf-8') : undefined);
      if (ca) {
        (options as Record<string, unknown>).tls = { ca };
      }
    }
    return options;
  }

  const dispatcher = getUndiciAgent(tlsOptions);
  if (dispatcher) {
    // @types/node models fetch with its bundled undici-types package while
    // runtime `undici` publishes the same Dispatcher contract from another
    // module identity. Native fetch accepts the external dispatcher.
    (options as Record<string, unknown>).dispatcher = dispatcher;
  }

  return options;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    // WHATWG URL canonicalizes ::ffff:127.x.x.x to ::ffff:7fxx:xxxx.
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized);
}

function assertAuthenticatedTransport(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      'Refusing to send an agent control-plane token over a non-HTTP transport'
    );
  }
  if (isLoopbackHostname(parsed.hostname)) return;

  if (parsed.protocol !== 'https:') {
    throw new Error(
      'Refusing to send an agent control-plane token over non-loopback HTTP'
    );
  }
  if (globalTLSOptions.verify === false) {
    throw new Error(
      'Refusing to send an agent control-plane token with TLS verification disabled'
    );
  }
}

function getAgentHeaders(
  url: string,
  baseHeaders: RequestInit['headers'],
  auth?: AgentRequestAuth
): Headers {
  const headers = new Headers(baseHeaders);
  if (headers.has('Authorization')) {
    throw new Error(
      'Agent control-plane authorization must be supplied through AgentRequestAuth'
    );
  }
  if (!auth) return headers;

  const token = auth.bearerToken;
  if (token.length < 32 || /[\r\n]/.test(token)) {
    throw new Error('Invalid agent control-plane bearer token');
  }

  assertAuthenticatedTransport(url);
  headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/**
 * Fetch an agent endpoint with the same TLS and per-request authorization
 * policy as the JSON helpers. This is the safe path for binary WAR uploads.
 */
export async function agentFetch(
  url: string,
  init: RequestInit,
  auth?: AgentRequestAuth
): Promise<Response> {
  const unsafeInit = init as RequestInit & { dispatcher?: unknown; agent?: unknown };
  if (Object.prototype.hasOwnProperty.call(unsafeInit, 'dispatcher') ||
      Object.prototype.hasOwnProperty.call(unsafeInit, 'agent')) {
    throw new Error('Caller-supplied TLS dispatchers are not allowed for agent requests');
  }

  const options = getFetchOptions(url, {
    method: init.method,
    headers: getAgentHeaders(url, init.headers, auth),
    body: init.body,
    signal: init.signal,
    redirect: 'error',
  });
  return fetch(url, options);
}

/**
 * GET request to agent endpoint
 */
export async function agentGet<T>(
  url: string,
  timeout = AGENT_TIMEOUT_MS,
  auth?: AgentRequestAuth
): Promise<T> {
  const options = getFetchOptions(url, {
    method: 'GET',
    headers: getAgentHeaders(url, { 'Accept': 'application/json' }, auth),
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent request failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

/**
 * POST request that handles 409 "Deployment in progress" specially
 * Returns a discriminated union so caller can handle in-progress case
 */
export async function agentPostWithStatus<T>(
  url: string,
  body: unknown,
  timeout = DEPLOYMENT_TIMEOUT_MS,
  auth?: AgentRequestAuth,
  deploymentId?: string
): Promise<AgentPostResult<T>> {
  let requestBody = body;
  if (deploymentId !== undefined) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return {
        ok: false,
        status: 0,
        inProgress: false,
        error: 'A deployment identity requires a JSON object request body',
      };
    }

    const submittedDeploymentId = (body as { deploymentId?: unknown }).deploymentId;
    if (submittedDeploymentId !== undefined && submittedDeploymentId !== deploymentId) {
      return {
        ok: false,
        status: 0,
        inProgress: false,
        error: 'Deployment identity in request body does not match the polling identity',
      };
    }
    requestBody = { ...body, deploymentId };
  }

  try {
    const options = getFetchOptions(url, {
      method: 'POST',
      headers: getAgentHeaders(url, {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(deploymentId ? { [DEPLOYMENT_ID_HEADER]: deploymentId } : {}),
      }, auth),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    const response = await fetch(url, options);

    if (response.ok) {
      const data = await response.json() as T;
      return { ok: true, data };
    }

    // A 409 is pollable only when the server proves that the operation already
    // running is the exact operation this caller submitted. Treating another
    // deployment's conflict as our own in-progress request can manufacture a
    // false success receipt.
    if (response.status === 409) {
      const text = await response.text();
      let activeDeploymentId: string | undefined;
      try {
        const parsed = JSON.parse(text) as { deploymentId?: unknown };
        if (typeof parsed.deploymentId === 'string') {
          activeDeploymentId = parsed.deploymentId;
        }
      } catch {
        // Preserve the server response below; an unparseable conflict is not
        // safe to poll.
      }
      return {
        ok: false,
        status: 409,
        inProgress:
          deploymentId !== undefined
          && activeDeploymentId !== undefined
          && activeDeploymentId === deploymentId,
        error: text,
        ...(activeDeploymentId ? { deploymentId: activeDeploymentId } : {}),
      };
    }

    const text = await response.text();
    return { ok: false, status: response.status, inProgress: false, error: text };
  } catch (err) {
    // Timeout or network error
    const message = getErrorMessage(err);
    const isTimeout = message.includes('timeout') || message.includes('aborted');
    return {
      ok: false,
      status: 0,
      // A timeout is recoverable only when the caller supplied an identity that
      // can be matched against the server's terminal receipt.
      inProgress: isTimeout && deploymentId !== undefined,
      error: message,
    };
  }
}

/**
 * Legacy agentPost for backwards compatibility (throws on non-2xx)
 */
export async function agentPost<T>(
  url: string,
  body: unknown,
  timeout = AGENT_TIMEOUT_MS,
  auth?: AgentRequestAuth,
): Promise<T> {
  const options = getFetchOptions(url, {
    method: 'POST',
    headers: getAgentHeaders(url, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }, auth),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent request failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Progress callback interface for deployment polling
 */
export interface ProgressCallback {
  waitingForDeployment(elapsed: number, step?: string): void;
}

/**
 * Poll deployment status until complete or timeout
 * Used when initial request times out or returns 409
 */
export async function pollDeploymentStatus(
  pluginUrl: string,
  deploymentId: string | number,
  progress: ProgressCallback,
  maxWaitMs = STATUS_POLL_MAX_WAIT_MS,
  auth?: AgentRequestAuth
): Promise<{ success: boolean; result?: DeployResult; error?: string }> {
  // Preserve source compatibility for callers compiled against the former
  // timestamp parameter, but never infer ownership from a wall-clock value.
  if (typeof deploymentId !== 'string') {
    return {
      success: false,
      error: 'Deployment operation identity is required; timestamp polling is unsafe',
    };
  }

  const pollStart = performance.now();

  while (performance.now() - pollStart < maxWaitMs) {
    try {
      const status = await agentGet<DeploymentStatusResponse>(
        `${pluginUrl}/deploy/status`,
        10000, // 10s timeout for status check
        auth
      );

      // A currently active request with the same ID takes precedence over an
      // older terminal receipt carrying a reused ID. Otherwise a terminal
      // result belongs to this caller only when its opaque identity matches
      // exactly. Wall clocks are deliberately irrelevant.
      if (status.deploying && status.deploymentId === deploymentId) {
        const elapsed = Math.round((performance.now() - pollStart) / 1000);
        progress.waitingForDeployment(elapsed, status.currentStep);
      } else if (status.lastDeploymentId === deploymentId) {
        if (status.lastResult?.success) {
          return { success: true, result: status.lastResult };
        } else {
          return {
            success: false,
            error: status.lastResult?.message ?? 'Deployment failed',
            result: status.lastResult,
          };
        }
      } else if (status.deploying) {
        return {
          success: false,
          error: 'A different deployment is in progress; refusing to use its result',
        };
      } else if (
        status.deploymentId === undefined
        && status.lastDeploymentId === undefined
      ) {
        return {
          success: false,
          error: 'Deployment status does not expose operation identity; completion cannot be verified safely',
        };
      }
      // NOTE: appDeployed/healthy and timestamps are observational only. They
      // must never be converted into a receipt for this operation.

      const remaining = maxWaitMs - (performance.now() - pollStart);
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, Math.min(STATUS_POLL_INTERVAL_MS, remaining)));
      }
    } catch {
      // Status check failed - server might be restarting, keep polling
      const remaining = maxWaitMs - (performance.now() - pollStart);
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, Math.min(STATUS_POLL_INTERVAL_MS, remaining)));
      }
    }
  }

  return { success: false, error: 'Timed out waiting for deployment to complete' };
}

/**
 * Build plugin URL from host and port, handling cases where:
 * 1. Host already includes protocol and port (e.g., http://host:9100)
 * 2. Host includes protocol but no port (e.g., http://host)
 * 3. Host is just hostname/IP (e.g., 172.16.220.55)
 *
 * @param useTLS - If true, use HTTPS protocol (default: false for backwards compat)
 */
/**
 * Per-host endpoint overrides. When a deploy runs through SSH tunnels, each
 * real host is mapped to a 127.0.0.1:<localPort> endpoint. buildPluginUrl
 * consults this map so only the URL the fetch hits is rewritten — the rest of
 * the orchestration keeps using the real host IP as identity/display/HAProxy key.
 */
const endpointOverrides = new Map<string, { host: string; port: number }>();

/** Register a tunnel endpoint for a host (real host → loopback:localPort). */
export function setEndpointOverride(host: string, localHost: string, localPort: number): void {
  endpointOverrides.set(host, { host: localHost, port: localPort });
}

/** Remove a single host's override. */
export function clearEndpointOverride(host: string): void {
  endpointOverrides.delete(host);
}

/** Remove all overrides (call in deploy teardown). */
export function clearAllEndpointOverrides(): void {
  endpointOverrides.clear();
}

/**
 * Resolve a (host, port) through the tunnel endpoint-override map.
 * When a deploy runs through SSH tunnels, the real host is mapped to a
 * 127.0.0.1:<localPort> forward — return that so callers route through the
 * tunnel instead of the (possibly loopback-only-bound) raw host. With no
 * override, returns { host, port } unchanged. Used by buildPluginUrl (the WAR
 * path) and buildAgentBaseUrl (the scheduler quiesce/status/resume path) so
 * both go through the same forward.
 */
export function resolveEndpoint(host: string, port: number): { host: string; port: number } {
  const override = endpointOverrides.get(host);
  return override ? { host: override.host, port: override.port } : { host, port };
}

export function buildPluginUrl(
  host: string,
  defaultPort: number,
  useTLS = false,
  pluginNamespace: string = 'payara'
): string {
  const override = endpointOverrides.get(host);
  if (override) {
    host = override.host;
    defaultPort = override.port;
    useTLS = false; // tunnel terminates at the loopback HTTP agent
  }

  const trimmed = host.replace(/\/$/, '');
  const defaultProtocol = useTLS ? 'https' : 'http';

  // Parse the URL to check for existing port
  try {
    // Add protocol if missing for URL parsing
    const urlString = trimmed.startsWith('http') ? trimmed : `${defaultProtocol}://${trimmed}`;
    const url = new URL(urlString);

    // If URL has a port explicitly set, use it; otherwise use defaultPort
    const effectivePort = url.port || String(defaultPort);
    return `${url.protocol}//${url.hostname}:${effectivePort}/plugins/${pluginNamespace}`;
  } catch {
    // Fallback for invalid URLs - just append port
    const withProtocol = trimmed.startsWith('http') ? trimmed : `${defaultProtocol}://${trimmed}`;
    return `${withProtocol}:${defaultPort}/plugins/${pluginNamespace}`;
  }
}

/**
 * Build plugin URL with automatic TLS detection
 * Uses HTTPS if TLS is configured, otherwise HTTP
 */
export function buildPluginUrlAuto(
  host: string,
  httpPort: number,
  httpsPort: number,
  pluginNamespace: string = 'payara'
): string {
  const useTLS = globalTLSOptions.caCertPath !== undefined ||
                 globalTLSOptions.caCert !== undefined ||
                 !globalTLSOptions.verify;
  const port = useTLS ? httpsPort : httpPort;
  return buildPluginUrl(host, port, useTLS, pluginNamespace);
}

/**
 * Probe a host to determine the best connection method
 * Tries HTTPS first (if configured or auto-detect enabled), falls back to HTTP
 *
 * @param host Host address
 * @param httpPort HTTP port (default: 9100)
 * @param httpsPort HTTPS port (default: 9443)
 * @param autoDetect If true, try HTTPS even without explicit TLS config
 * @param pluginNamespace Plugin namespace segment for the `/plugins/<namespace>` URL (default: 'payara')
 * @returns Connection info with the working configuration
 */
export async function probeHost(
  host: string,
  httpPort = 9100,
  httpsPort = 9443,
  autoDetect = true,
  pluginNamespace: string = 'payara'
): Promise<ConnectionInfo> {
  const tlsConfigured = globalTLSOptions.caCertPath !== undefined ||
                        globalTLSOptions.caCert !== undefined ||
                        !globalTLSOptions.verify;

  // If TLS is explicitly configured, use it directly
  if (tlsConfigured) {
    const pluginUrl = buildPluginUrl(host, httpsPort, true, pluginNamespace);
    return {
      host,
      tls: true,
      verified: globalTLSOptions.verify !== false,
      port: httpsPort,
      pluginUrl,
    };
  }

  // Try HTTPS first if auto-detect is enabled
  if (autoDetect) {
    try {
      const httpsUrl = buildPluginUrl(host, httpsPort, true, pluginNamespace);
      // Quick probe with short timeout - try unverified first to see if HTTPS is available
      const probeOptions = getFetchOptions(`${httpsUrl}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      }, { ...globalTLSOptions, verify: false });

      try {
        const response = await fetch(`${httpsUrl}/status`, probeOptions);
        if (response.ok || response.status === 401 || response.status === 403) {
          // HTTPS is available - keep using unverified mode since we detected it
          return {
            host,
            tls: true,
            verified: false,
            port: httpsPort,
            pluginUrl: httpsUrl,
          };
        }
      } catch {
        // HTTPS probe failed - fall through to HTTP
      }
    } catch {
      // HTTPS not available, fall through to HTTP
    }
  }

  // Fall back to HTTP
  const pluginUrl = buildPluginUrl(host, httpPort, false, pluginNamespace);
  return {
    host,
    tls: false,
    verified: false,
    port: httpPort,
    pluginUrl,
  };
}

/**
 * Probe multiple hosts in parallel
 */
export async function probeHosts(
  hosts: string[],
  httpPort = 9100,
  httpsPort = 9443,
  autoDetect = true,
  pluginNamespace: string = 'payara'
): Promise<Map<string, ConnectionInfo>> {
  const results = new Map<string, ConnectionInfo>();

  const probeResults = await Promise.all(
    hosts.map(async (host) => {
      try {
        const info = await probeHost(host, httpPort, httpsPort, autoDetect, pluginNamespace);
        return { host, info };
      } catch {
        // Return HTTP fallback on error
        return {
          host,
          info: {
            host,
            tls: false,
            verified: false,
            port: httpPort,
            pluginUrl: buildPluginUrl(host, httpPort, false, pluginNamespace),
          },
        };
      }
    })
  );

  for (const { host, info } of probeResults) {
    results.set(host, info);
  }

  return results;
}

/**
 * Format connection info for display
 */
export function formatConnectionInfo(info: ConnectionInfo, plain = false): string {
  if (!info.tls) {
    return plain ? 'HTTP' : '\x1b[33mHTTP\x1b[0m'; // Yellow for unencrypted
  }
  if (info.verified) {
    return plain ? 'HTTPS (verified)' : '\x1b[32mHTTPS\x1b[0m'; // Green for verified
  }
  return plain ? 'HTTPS (unverified)' : '\x1b[36mHTTPS\x1b[0m'; // Cyan for unverified
}

/**
 * Get a short TLS indicator for task titles
 */
export function getTLSIndicator(info: ConnectionInfo, plain = false): string {
  if (!info.tls) {
    return plain ? '[HTTP]' : '\x1b[33m🔓\x1b[0m';
  }
  if (info.verified) {
    return plain ? '[TLS]' : '\x1b[32m🔒\x1b[0m';
  }
  return plain ? '[TLS*]' : '\x1b[36m🔐\x1b[0m';
}
