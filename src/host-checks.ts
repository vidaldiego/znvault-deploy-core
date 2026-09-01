// Path: src/host-checks.ts
// Host reachability and plugin version checks

import {
  buildPluginUrl,
  agentFetch,
  agentGet,
  type AgentRequestAuth,
} from './http-client.js';
import { MAX_RETRIES, getRetryDelay } from './constants.js';
import { getErrorMessage } from './utils/error.js';
import type {
  PluginVersionsResponse,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  auth?: AgentRequestAuth
): Promise<TriggerUpdateResult> {
  const pluginUrl = buildPluginUrl(host, port, useTLS, pluginNamespace);
  const updateUrl = pluginUrl.replace(`/plugins/${pluginNamespace}`, '/plugins/update');

  try {
    // Import agentPost for TLS-aware POST
    const { agentPost } = await import('./http-client.js');
    const data = await agentPost<PluginUpdateResponse>(updateUrl, {}, undefined, auth);
    return { success: true, response: data };
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.includes('timeout') || message.includes('aborted')) {
      return { success: false, error: 'Update timed out (npm install may still be running)' };
    }
    if (message.includes('404')) {
      return { success: false, error: 'Agent does not support plugin updates (upgrade agent to 1.15+)' };
    }
    return { success: false, error: message };
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
