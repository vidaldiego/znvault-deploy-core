// Path: src/host-checks.ts
// Host reachability and plugin version checks

import {
  buildPluginUrl,
  agentFetch,
  agentGet,
  type AgentRequestAuth,
} from './http-client.js';
import {
  AGENT_TIMEOUT_MS,
  MAX_RETRIES,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_MAX_WAIT_MS,
  getRetryDelay,
} from './constants.js';
import { getErrorMessage } from './utils/error.js';
import type {
  PluginVersionsResponse,
  PluginUpdateRequest,
  PluginUpdateResponse,
  PluginVersionCheckResult,
  TriggerUpdateResult,
  HealthCheckConfig,
  HealthCheckResult,
  PreflightResult,
} from './types.js';

/** Default health check configuration values */
const HEALTH_CHECK_DEFAULTS = {
  port: 8080,
  expectedStatus: 200,
  timeout: 5000,
  retries: 5,
  retryDelay: 3000,
} as const;

interface AgentHealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  plugins?: Array<{
    name: string;
    version?: string;
    details?: { running?: boolean };
  }>;
}

const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface PluginUpdatePendingWire {
  status: 'pending';
  requestId: string;
  package: string;
  previousVersion: string;
  targetVersion: string;
  requestedAt: string;
  pollPath?: string;
}

interface PluginUpdateFailedWire {
  status: 'failed';
  requestId?: string;
  package?: string;
  previousVersion?: string;
  targetVersion?: string;
  installedVersion?: string;
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  code?: string;
  error?: string;
  willRestart?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function hasMonotonicReceiptTimestamps(value: Record<string, unknown>): value is Record<string, unknown> & {
  requestedAt: string;
  startedAt: string;
  finishedAt: string;
} {
  return isExactIsoTimestamp(value.requestedAt)
    && isExactIsoTimestamp(value.startedAt)
    && isExactIsoTimestamp(value.finishedAt)
    && Date.parse(value.requestedAt) <= Date.parse(value.startedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt);
}

/**
 * Validate the small public `/health` surface used as compatibility evidence.
 * A 503 is a valid transport response only when the body explicitly reports
 * `unhealthy`; malformed/ambiguous snapshots fail closed.
 */
function parseAgentHealthSnapshot(value: unknown, httpStatus: number): AgentHealthSnapshot {
  if (!isRecord(value)) {
    throw new Error('Agent health snapshot is not a JSON object');
  }

  const status = value.status;
  if (status !== 'healthy' && status !== 'degraded' && status !== 'unhealthy') {
    throw new Error('Agent health snapshot has an unknown status');
  }
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    throw new Error('Agent health snapshot has an unknown version');
  }
  if ((httpStatus === 503) !== (status === 'unhealthy')) {
    throw new Error(`Agent health snapshot contradicts HTTP ${httpStatus}`);
  }

  let plugins: AgentHealthSnapshot['plugins'];
  if (value.plugins !== undefined) {
    if (!Array.isArray(value.plugins)) {
      throw new Error('Agent health snapshot has an invalid plugins list');
    }
    plugins = value.plugins.map((plugin) => {
      if (!isRecord(plugin) || typeof plugin.name !== 'string' || plugin.name.trim() === '') {
        throw new Error('Agent health snapshot has an invalid plugin entry');
      }
      if (
        plugin.version !== undefined
        && (typeof plugin.version !== 'string' || !VERSION_PATTERN.test(plugin.version))
      ) {
        throw new Error(`Agent health snapshot has an invalid version for plugin '${plugin.name}'`);
      }
      if (plugin.details !== undefined && !isRecord(plugin.details)) {
        throw new Error(`Agent health snapshot has invalid details for plugin '${plugin.name}'`);
      }
      const running = isRecord(plugin.details) && typeof plugin.details.running === 'boolean'
        ? plugin.details.running
        : undefined;
      return {
        name: plugin.name,
        ...(plugin.version === undefined ? {} : { version: plugin.version }),
        ...(running === undefined ? {} : { details: { running } }),
      };
    });
  }

  return {
    status,
    version: value.version,
    ...(plugins === undefined ? {} : { plugins }),
  };
}

/**
 * Check plugin versions on a host
 */
export async function checkPluginVersions(
  host: string,
  port: number,
  useTLS = false,
  pluginNamespace: string = 'payara',
  auth?: AgentRequestAuth
): Promise<PluginVersionCheckResult> {
  const pluginUrl = buildPluginUrl(host, port, useTLS, pluginNamespace);
  const versionsUrl = pluginUrl.replace(`/plugins/${pluginNamespace}`, '/plugins/versions');

  try {
    const data = await agentGet<PluginVersionsResponse>(versionsUrl, 10000, auth);
    return { success: true, response: data };
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.includes('timeout') || message.includes('aborted')) {
      return { success: false, error: 'Version check timed out' };
    }
    if (message.includes('404')) {
      return { success: false, error: 'Agent does not support plugin version check (upgrade agent to 1.15+)' };
    }
    return { success: false, error: message };
  }
}

/**
 * Trigger plugin update on a host
 */
export async function triggerPluginUpdate(
  host: string,
  port: number,
  useTLS = false,
  pluginNamespace: string = 'payara',
  request: PluginUpdateRequest,
  auth?: AgentRequestAuth
): Promise<TriggerUpdateResult> {
  if (
    !request
    || typeof request.requestId !== 'string'
    || !UUID_V4_PATTERN.test(request.requestId)
    || typeof request.package !== 'string'
    || request.package.length > 214
    || !NPM_PACKAGE_PATTERN.test(request.package)
    || typeof request.expectedCurrentVersion !== 'string'
    || !EXACT_VERSION_PATTERN.test(request.expectedCurrentVersion)
    || typeof request.expectedVersion !== 'string'
    || !EXACT_VERSION_PATTERN.test(request.expectedVersion)
  ) {
    return {
      success: false,
      error: 'Exact request UUID, plugin package, current semver, and target semver are required for updates',
    };
  }

  const pluginUrl = buildPluginUrl(host, port, useTLS, pluginNamespace);
  const updateUrl = pluginUrl.replace(`/plugins/${pluginNamespace}`, '/plugins/update');
  const statusUrl = `${updateUrl}/${encodeURIComponent(request.requestId)}`;
  const expectedPollPath = `/plugins/update/${request.requestId}`;
  const pollStartedAt = performance.now();

  const parseJsonObject = async (response: Response): Promise<Record<string, unknown> | undefined> => {
    try {
      const value = await response.json() as unknown;
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const validatePending = (value: Record<string, unknown>): PluginUpdatePendingWire | undefined => {
    if (
      value.status !== 'pending'
      || value.requestId !== request.requestId
      || value.package !== request.package
      || value.previousVersion !== request.expectedCurrentVersion
      || value.targetVersion !== request.expectedVersion
      || !isExactIsoTimestamp(value.requestedAt)
      || (value.pollPath !== undefined && value.pollPath !== expectedPollPath)
    ) {
      return undefined;
    }
    return value as unknown as PluginUpdatePendingWire;
  };

  const validateSuccess = (value: Record<string, unknown>): PluginUpdateResponse | undefined => {
    if (
      value.status !== 'succeeded'
      || value.requestId !== request.requestId
      || value.package !== request.package
      || value.previousVersion !== request.expectedCurrentVersion
      || value.targetVersion !== request.expectedVersion
      || value.newVersion !== request.expectedVersion
      || value.installedVersion !== request.expectedVersion
      || !hasMonotonicReceiptTimestamps(value)
    ) {
      return undefined;
    }
    const changed = request.expectedCurrentVersion !== request.expectedVersion;
    if (value.updated !== (changed ? 1 : 0) || value.willRestart !== changed) {
      return undefined;
    }
    return {
      requestId: request.requestId,
      updated: changed ? 1 : 0,
      willRestart: changed,
      results: [{
        package: request.package,
        previousVersion: request.expectedCurrentVersion,
        newVersion: request.expectedVersion,
        success: true,
      }],
      message: changed ? 'Exact plugin update completed' : 'Exact plugin version already installed',
      timestamp: value.finishedAt,
      requestedAt: value.requestedAt,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
    };
  };

  const correlatedFailure = (value: Record<string, unknown> | undefined): PluginUpdateFailedWire | undefined => {
    if (!value || value.status !== 'failed') return undefined;
    if (value.requestId !== request.requestId) return undefined;
    if (value.package !== request.package) return undefined;
    if (
      value.previousVersion !== undefined
      && (
        typeof value.previousVersion !== 'string'
        || !EXACT_VERSION_PATTERN.test(value.previousVersion)
      )
    ) return undefined;
    if (value.targetVersion !== request.expectedVersion) {
      return undefined;
    }
    if (value.willRestart !== false) return undefined;
    return value as unknown as PluginUpdateFailedWire;
  };

  const failureMessage = (value: PluginUpdateFailedWire | undefined, status: number): string => {
    if (!value) return `Agent returned an uncorrelated plugin update failure (HTTP ${status})`;
    return value.error ?? value.code ?? `Plugin update failed (HTTP ${status})`;
  };

  const pollExactReceipt = async (): Promise<TriggerUpdateResult> => {
    while (performance.now() - pollStartedAt < STATUS_POLL_MAX_WAIT_MS) {
      try {
        const response = await agentFetch(statusUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(Math.max(
            1,
            Math.floor(Math.min(
              AGENT_TIMEOUT_MS,
              STATUS_POLL_MAX_WAIT_MS - (performance.now() - pollStartedAt)
            ))
          )),
        }, auth);
        const value = await parseJsonObject(response);
        if (response.status === 200) {
          const data = value && validateSuccess(value);
          return data
            ? { success: true, response: data }
            : { success: false, error: 'Agent returned an invalid or uncorrelated update success receipt' };
        }
        if (response.status === 202) {
          if (!value || !validatePending(value)) {
            return { success: false, error: 'Agent returned an invalid or uncorrelated pending update receipt' };
          }
        } else if (response.status === 409 || response.status === 502) {
          const failure = correlatedFailure(value);
          return { success: false, error: failureMessage(failure, response.status) };
        } else if (response.status === 401 || response.status === 403) {
          return { success: false, error: `Agent rejected plugin update receipt access (HTTP ${response.status})` };
        } else if (response.status !== 404 && response.status >= 400 && response.status < 500) {
          return { success: false, error: `Agent rejected plugin update receipt polling (HTTP ${response.status})` };
        }
      } catch {
        // The accepted update intentionally restarts the agent. Transport loss
        // is therefore retried, but can never itself become success.
      }

      const remaining = STATUS_POLL_MAX_WAIT_MS - (performance.now() - pollStartedAt);
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(
          resolve,
          Math.min(STATUS_POLL_INTERVAL_MS, remaining)
        ));
      }
    }
    return {
      success: false,
      error: `Timed out waiting for exact plugin update receipt ${request.requestId}`,
    };
  };

  try {
    const response = await agentFetch(updateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    }, auth);
    const value = await parseJsonObject(response);
    if (response.status === 200) {
      return {
        success: false,
        error: 'Agent returned terminal plugin update state from POST; a durable GET receipt is required',
      };
    }
    if (response.status === 202) {
      if (!value || !validatePending(value)) {
        return { success: false, error: 'Agent returned an invalid or uncorrelated pending update receipt' };
      }
      return pollExactReceipt();
    }
    if (response.status === 409 || response.status === 502) {
      const failure = correlatedFailure(value);
      return { success: false, error: failureMessage(failure, response.status) };
    }
    if (response.status === 404) {
      return { success: false, error: 'Agent does not support recoverable plugin updates (upgrade agent to 2.0+)' };
    }
    return { success: false, error: `Agent plugin update request failed (HTTP ${response.status})` };
  } catch {
    // The POST may have crossed the transport boundary. Its UUID is durable,
    // so poll only that exact operation rather than retrying the mutation.
    return pollExactReceipt();
  }
}

/**
 * Check if a host is reachable and get basic info
 * Uses same retry logic as deployment for consistency
 */
export async function checkHostReachable(
  host: string,
  port: number,
  onRetry?: (attempt: number, delay: number, error: string) => void,
  useTLS = false,
  pluginNamespace: string = 'payara'
): Promise<PreflightResult> {
  const pluginUrl = buildPluginUrl(host, port, useTLS, pluginNamespace);
  const healthUrl = pluginUrl.replace(`/plugins/${pluginNamespace}`, '/health');

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await agentFetch(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200 && response.status !== 503) {
        throw new Error(`Agent health request failed: HTTP ${response.status}`);
      }
      const health = parseAgentHealthSnapshot(await response.json(), response.status);

      const matchedPlugin = health.plugins?.find(p => p.name === pluginNamespace);

      return {
        host,
        reachable: true,
        healthHttpStatus: response.status,
        healthStatus: health.status,
        agentVersion: health.version,
        pluginVersion: matchedPlugin?.version,
        pluginRunning: matchedPlugin?.details?.running,
      };
    } catch (err) {
      lastError = getErrorMessage(err);
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt);
        onRetry?.(attempt, delay, lastError);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
  }

  return {
    host,
    reachable: false,
    error: lastError,
  };
}

/**
 * Perform post-deployment health check on the application
 * Retries with configurable delay until success or max retries reached
 *
 * @param host Host address (IP or hostname)
 * @param config Health check configuration
 * @param onAttempt Optional callback for each attempt
 * @returns Health check result
 */
export async function performHealthCheck(
  host: string,
  config: HealthCheckConfig,
  onAttempt?: (attempt: number, maxAttempts: number, status?: number, error?: string) => void
): Promise<HealthCheckResult> {
  const port = config.port ?? HEALTH_CHECK_DEFAULTS.port;
  const expectedStatus = config.expectedStatus ?? HEALTH_CHECK_DEFAULTS.expectedStatus;
  const timeout = config.timeout ?? HEALTH_CHECK_DEFAULTS.timeout;
  const maxRetries = config.retries ?? HEALTH_CHECK_DEFAULTS.retries;
  const retryDelay = config.retryDelay ?? HEALTH_CHECK_DEFAULTS.retryDelay;

  // Build health check URL
  const path = config.path.startsWith('/') ? config.path : `/${config.path}`;
  const url = `http://${host}:${port}${path}`;

  const startTime = Date.now();
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      onAttempt?.(attempt, maxRetries, undefined, undefined);

      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
      });

      lastStatus = response.status;

      if (response.status === expectedStatus) {
        return {
          success: true,
          status: response.status,
          attempts: attempt,
          totalTime: Date.now() - startTime,
        };
      }

      // Wrong status code
      lastError = `Expected ${expectedStatus}, got ${response.status}`;
      onAttempt?.(attempt, maxRetries, response.status, lastError);
    } catch (err) {
      lastError = getErrorMessage(err);
      if (lastError.includes('timeout') || lastError.includes('aborted')) {
        lastError = 'Request timed out';
      } else if (lastError.includes('ECONNREFUSED')) {
        lastError = 'Connection refused';
      }
      onAttempt?.(attempt, maxRetries, undefined, lastError);
    }

    // Wait before retry (unless this was the last attempt)
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  return {
    success: false,
    status: lastStatus,
    error: lastError ?? 'Health check failed',
    attempts: maxRetries,
    totalTime: Date.now() - startTime,
  };
}
