// Path: src/cli/haproxy.ts
// HAProxy drain/ready operations via SSH for zero-downtime rolling deployments

import { execFile } from 'node:child_process';
import type { HAProxyConfig } from './types.js';

const DEFAULT_USER = 'sysadmin';
const DEFAULT_SSH_PORT = 22;
const DEFAULT_SOCKET_PATH = '/run/haproxy/admin.sock';
const DEFAULT_SSH_TIMEOUT = 10000;
const HAPROXY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const HAPROXY_SOCKET_PATH_PATTERN = /^\/[A-Za-z0-9_./-]{1,4095}$/u;
const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:%-]{0,252}$/u;

function validateSSHConnection(host: string, user: string, port: number, timeout: number): void {
  if (typeof host !== 'string' || !SSH_HOST_PATTERN.test(host)) {
    throw new Error('HAProxy SSH host contains unsupported characters');
  }
  if (typeof user !== 'string' || !SSH_USER_PATTERN.test(user)) {
    throw new Error('HAProxy SSH user contains unsupported characters');
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('HAProxy SSH port must be an integer between 1 and 65535');
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error('HAProxy SSH timeout must be a positive integer');
  }
}

function validateSSHBatch(hosts: string[], user: string, port: number, timeout: number): void {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('HAProxy SSH hosts must contain at least one destination');
  }
  if (new Set(hosts).size !== hosts.length) {
    throw new Error('HAProxy SSH hosts must not contain duplicates');
  }
  for (const host of hosts) {
    validateSSHConnection(host, user, port, timeout);
  }
}

/**
 * Result from a single SSH command execution
 */
export interface SSHExecResult {
  host: string;
  success: boolean;
  stdout?: string;
  error?: string;
}

/**
 * Aggregate result from running a command across all HAProxy hosts
 */
export interface HAProxyOperationResult {
  success: boolean;
  results: SSHExecResult[];
}

/**
 * Execute a command on a remote host via SSH
 *
 * Uses BatchMode=yes to fail immediately instead of prompting for password.
 * Uses ConnectTimeout to avoid hanging on unreachable hosts.
 */
export function sshExec(
  host: string,
  user: string,
  port: number,
  command: string,
  timeout: number
): Promise<SSHExecResult> {
  validateSSHConnection(host, user, port, timeout);
  const connectTimeout = Math.max(1, Math.ceil(timeout / 1000));

  return new Promise((resolve) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `ConnectTimeout=${connectTimeout}`,
      '-p', String(port),
      `${user}@${host}`,
      command,
    ];

    const child = execFile('ssh', args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || error.message;
        resolve({ host, success: false, error: msg });
      } else {
        resolve({ host, success: true, stdout: stdout.trim() });
      }
    });

    // Safety: kill on timeout (execFile handles this, but just in case)
    child.on('error', (err) => {
      resolve({ host, success: false, error: err.message });
    });
  });
}

/**
 * Build the socat command to set HAProxy server state
 */
function buildSocatCommand(socketPath: string, backend: string, serverName: string, state: 'drain' | 'ready', sudo: boolean): string {
  if (typeof backend !== 'string' || !HAPROXY_IDENTIFIER_PATTERN.test(backend)) {
    throw new Error('HAProxy backend contains unsupported characters');
  }
  if (typeof serverName !== 'string' || !HAPROXY_IDENTIFIER_PATTERN.test(serverName)) {
    throw new Error('HAProxy server name contains unsupported characters');
  }
  if (typeof socketPath !== 'string' || !HAPROXY_SOCKET_PATH_PATTERN.test(socketPath)) {
    throw new Error('HAProxy socketPath must be an absolute shell-safe path');
  }

  // ssh sends one command string to the remote login shell. Keep that program
  // fixed, validate every substituted token above, and quote each data value as
  // a single POSIX-shell argument as defense in depth.
  const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  const runtimeCommand = `set server ${backend}/${serverName} state ${state}`;
  const prefix = sudo ? 'sudo ' : '';
  return `printf '%s\\n' ${quote(runtimeCommand)} | ${prefix}socat stdio ${quote(socketPath)}`;
}

/**
 * Set server state (drain/ready) across all HAProxy hosts in parallel
 *
 * Runs the command on every HAProxy host simultaneously. Returns success
 * only if ALL hosts succeed — partial drain could cause inconsistent routing.
 */
export async function setServerState(
  config: HAProxyConfig,
  appHost: string,
  state: 'drain' | 'ready'
): Promise<HAProxyOperationResult> {
  const serverName = config.serverMap[appHost];
  if (!serverName) {
    return {
      success: false,
      results: [{
        host: appHost,
        success: false,
        error: `No HAProxy server mapping for host "${appHost}"`,
      }],
    };
  }

  const user = config.user ?? DEFAULT_USER;
  const port = config.sshPort ?? DEFAULT_SSH_PORT;
  const socketPath = config.socketPath ?? DEFAULT_SOCKET_PATH;
  const timeout = config.sshTimeout ?? DEFAULT_SSH_TIMEOUT;
  const sudo = config.sudo !== false; // default true
  validateSSHBatch(config.hosts, user, port, timeout);
  const command = buildSocatCommand(socketPath, config.backend, serverName, state, sudo);

  const results = await Promise.all(
    config.hosts.map(haHost => sshExec(haHost, user, port, command, timeout))
  );

  const allSuccess = results.every(r => r.success);
  return { success: allSuccess, results };
}

/**
 * Drain a server from all HAProxy load balancers
 */
export async function drainServer(config: HAProxyConfig, appHost: string): Promise<HAProxyOperationResult> {
  return setServerState(config, appHost, 'drain');
}

/**
 * Set a server ready on all HAProxy load balancers
 */
export async function readyServer(config: HAProxyConfig, appHost: string): Promise<HAProxyOperationResult> {
  return setServerState(config, appHost, 'ready');
}

/**
 * Pre-flight connectivity check: SSH to each HAProxy host and run a no-op
 */
export async function testHAProxyConnectivity(config: HAProxyConfig): Promise<HAProxyOperationResult> {
  const user = config.user ?? DEFAULT_USER;
  const port = config.sshPort ?? DEFAULT_SSH_PORT;
  const timeout = config.sshTimeout ?? DEFAULT_SSH_TIMEOUT;
  validateSSHBatch(config.hosts, user, port, timeout);

  const results = await Promise.all(
    config.hosts.map(host => sshExec(host, user, port, 'echo ok', timeout))
  );

  const allSuccess = results.every(r => r.success);
  return { success: allSuccess, results };
}

/**
 * Find app hosts that don't have a serverMap entry
 */
export function getUnmappedHosts(config: HAProxyConfig, appHosts: string[]): string[] {
  return appHosts.filter(host => !config.serverMap[host]);
}
