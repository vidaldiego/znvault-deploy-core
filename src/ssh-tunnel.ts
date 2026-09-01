// Path: src/cli/ssh-tunnel.ts
// SSH-CA-authenticated tunnel manager. Opens `znvault ssh forward` local
// forwards to each host's loopback-bound agent (:9100), so deploys work
// while the agent never exposes :9100 on the network.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Resolve the znvault CLI binary to shell out to (O2).
 * Order: $ZNVAULT_BIN (if exists) → sibling of process.execPath → "znvault" on PATH.
 */
export function resolveZnvaultBin(): string {
  const fromEnv = process.env.ZNVAULT_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // The plugin runs inside the znvault process, so a sibling of the node
  // binary's dir is a good guess for a bundled install.
  try {
    const sibling = join(dirname(process.execPath), 'znvault');
    if (existsSync(sibling)) return sibling;
  } catch {
    // ignore — fall through to PATH
  }

  return 'znvault';
}

import { spawn, type ChildProcess } from 'node:child_process';

/** An open tunnel: local port to use, and a teardown. */
export interface Tunnel {
  host: string;
  localPort: number;
  /** PID of the spawned `znvault ssh forward` child (for synchronous orphan-kill backstops). */
  pid?: number;
  close(): Promise<void>;
}

export interface OpenTunnelOptions {
  /** SSH user; defaults to convention. Honors ~/.ssh/config either way. */
  user?: string;
  /** Remote agent port to forward to (default 9100). */
  remotePort?: number;
  /** Path/name of the znvault binary (default: resolveZnvaultBin()). */
  znvaultBin?: string;
  /** Max ms for each startup phase: local-port report, then `/live` (default 15000). */
  readinessTimeoutMs?: number;
}

const DEFAULT_REMOTE_PORT = 9100;
const DEFAULT_READINESS_TIMEOUT_MS = 15000;
const READINESS_POLL_INTERVAL_MS = 250;
const TERMINATION_GRACE_MS = 500;

function childHasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

/**
 * Open an SSH-CA-authenticated local forward to host:remotePort via
 * `znvault ssh forward --print-port`. Resolves once the tunnel's local port
 * returns a valid GET /live response, or rejects on spawn/exit/readiness
 * failure. Liveness is deliberately separate from `/health`: an Agent 2
 * instance may correctly return 503 while a plugin is unhealthy, but the SSH
 * forward is already usable for the authenticated recovery preflight.
 */
export async function openTunnel(host: string, opts: OpenTunnelOptions = {}): Promise<Tunnel> {
  const bin = opts.znvaultBin ?? resolveZnvaultBin();
  const user = opts.user ?? 'sysadmin';
  const remotePort = opts.remotePort ?? DEFAULT_REMOTE_PORT;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  const args = [
    'ssh', 'forward',
    '--print-port',
    '-L', `127.0.0.1:0:127.0.0.1:${remotePort}`,
    `${user}@${host}`,
  ];

  const child: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (!child.pid || childHasExited(child)) return;

      child.kill('SIGTERM');
      if (await waitForChildExit(child, TERMINATION_GRACE_MS)) return;

      child.kill('SIGKILL');
      if (await waitForChildExit(child, TERMINATION_GRACE_MS)) return;

      throw new Error(`Failed to terminate ssh forward child ${child.pid}`);
    })();
    return closePromise;
  };

  const localPort = await new Promise<number>((resolve, reject) => {
    let buf = '';
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      child.stdout?.removeListener('data', onData);
    };
    const rejectAfterClose = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void close().then(
        () => reject(error),
        (closeError: unknown) => reject(new Error(
          `${error.message}; ${closeError instanceof Error ? closeError.message : String(closeError)}`
        )),
      );
    };
    const onClose = (code: number | null): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`ssh forward exited (code ${code ?? 'null'}) before reporting a port`));
      }
    };
    const onError = (err: Error): void => {
      rejectAfterClose(err);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);          // consume the line
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { localPort?: number };
          if (
            typeof parsed.localPort === 'number'
            && Number.isInteger(parsed.localPort)
            && parsed.localPort >= 1
            && parsed.localPort <= 65535
          ) {
            settled = true;
            cleanup();
            resolve(parsed.localPort);
            return;
          }
        } catch { /* not the JSON line; try the next one */ }
      }
    };
    const timeout = setTimeout(() => {
      rejectAfterClose(new Error(
        `ssh forward did not report a valid local port within ${readinessTimeoutMs}ms`
      ));
    }, readinessTimeoutMs);
    child.on('close', onClose);
    child.on('error', onError);
    child.stdout?.on('data', onData);
  });

  // Transport-level readiness (component owns this, not `forward`): poll the
  // agent's public liveness rail and require its exact JSON contract. Do not
  // use /health here: a legitimate unhealthy snapshot is HTTP 503.
  const deadline = Date.now() + readinessTimeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/live`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
      } else {
        const body = await res.json() as unknown;
        if (isRecord(body) && body.alive === true) {
          return { host, localPort, pid: child.pid, close };
        }
        lastErr = 'invalid /live response';
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, READINESS_POLL_INTERVAL_MS));
  }
  await close();
  throw new Error(`Tunnel to ${host} opened (port ${localPort}) but /live never answered: ${lastErr}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a host is loopback (already locally reachable, no tunnel needed).
 */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
