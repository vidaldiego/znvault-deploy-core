// Path: test/ssh-tunnel.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExistsSync = vi.fn();
vi.mock('node:fs', () => ({ existsSync: (...a: unknown[]) => mockExistsSync(...a) }));

const { resolveZnvaultBin } = await import('../src/ssh-tunnel.js');

describe('resolveZnvaultBin', () => {
  const origEnv = process.env.ZNVAULT_BIN;
  beforeEach(() => { vi.clearAllMocks(); delete process.env.ZNVAULT_BIN; });
  afterEach(() => { if (origEnv === undefined) delete process.env.ZNVAULT_BIN; else process.env.ZNVAULT_BIN = origEnv; });

  it('prefers ZNVAULT_BIN when set and existing', () => {
    process.env.ZNVAULT_BIN = '/custom/znvault';
    mockExistsSync.mockImplementation((p: string) => p === '/custom/znvault');
    expect(resolveZnvaultBin()).toBe('/custom/znvault');
  });

  it('falls back to bare "znvault" when nothing else resolves', () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveZnvaultBin()).toBe('znvault');
  });
});

import * as http from 'node:http';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => mockSpawn(...a) }));

// Re-import with child_process mocked
const tunnelMod = await import('../src/ssh-tunnel.js');

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: NodeJS.Signals) => boolean;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    setTimeout(() => child.emit('exit', null, signal), 0);
    return true;
  });
  return child;
}

function fakeForwardChild(localPort: number): FakeChild {
  const child = makeChild();
  // Emit the contract line on next tick
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ localPort, pid: 4242, forwardUp: true }) + '\n'));
  }, 5);
  return child;
}

/** Emits one or more noise lines BEFORE the JSON contract line. */
function fakeForwardChildWithPrefix(localPort: number, prefix: string): FakeChild {
  const child = makeChild();
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(prefix));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ localPort, pid: 4242, forwardUp: true }) + '\n'));
  }, 5);
  return child;
}

/** Emits the JSON contract line split across two separate data chunks. */
function fakeForwardChildSplit(localPort: number): FakeChild {
  const child = makeChild();
  const full = JSON.stringify({ localPort, pid: 4242, forwardUp: true }) + '\n';
  const at = '{"localPo'.length;
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(full.slice(0, at)));
    child.stdout.emit('data', Buffer.from(full.slice(at)));
  }, 5);
  return child;
}

describe('openTunnel', () => {
  let agent: http.Server;
  let agentPort: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    agent = http.createServer((req, res) => {
      // Recovery may legitimately start with unhealthy Payara, so /health is
      // 503. The tunnel readiness contract is the independent /live rail.
      if (req.url === '/health') { res.writeHead(503); res.end('{"status":"unhealthy"}'); }
      else if (req.url === '/live') { res.writeHead(200); res.end('{"alive":true}'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r));
    agentPort = (agent.address() as import('node:net').AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => agent.close(() => r())));

  it('opens a tunnel, reports the local port, and tears down on close', async () => {
    // The fake forward "binds" the same port our local stub agent listens on,
    // so the readiness probe to 127.0.0.1:<port>/live hits the stub.
    const child = fakeForwardChild(agentPort);
    mockSpawn.mockReturnValue(child);

    const t = await tunnelMod.openTunnel('192.0.2.55', {
      user: 'sysadmin', remotePort: 9100, znvaultBin: 'znvault', readinessTimeoutMs: 2000,
    });

    expect(t.localPort).toBe(agentPort);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    // spawn called with ssh forward --print-port
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('ssh');
    expect(args).toContain('forward');
    expect(args).toContain('--print-port');

    await t.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it('uses /live transport readiness even while /health is HTTP 503', async () => {
    const child = fakeForwardChild(agentPort);
    mockSpawn.mockReturnValue(child);

    const t = await tunnelMod.openTunnel('192.0.2.55', {
      znvaultBin: 'znvault', readinessTimeoutMs: 2000,
    });

    expect(t.localPort).toBe(agentPort);
    await t.close();
  });

  it('throws if the forward child exits before printing a port', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = tunnelMod.openTunnel('h', { znvaultBin: 'znvault', readinessTimeoutMs: 500 });
    setTimeout(() => child.emit('close', 255), 5);
    await expect(p).rejects.toThrow();
  });

  it('times out and kills a forward child that never reports a local port', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    await expect(
      tunnelMod.openTunnel('192.0.2.55', {
        znvaultBin: 'znvault', readinessTimeoutMs: 100,
      }),
    ).rejects.toThrow(/did not report a valid local port within 100ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  }, 3000);

  it('escalates from SIGTERM to SIGKILL when the forward ignores termination', async () => {
    const child = fakeForwardChild(agentPort);
    child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      if (signal === 'SIGKILL') {
        setTimeout(() => child.emit('exit', null, signal), 0);
      }
      return true;
    });
    mockSpawn.mockReturnValue(child);

    const tunnel = await tunnelMod.openTunnel('192.0.2.55', {
      znvaultBin: 'znvault', readinessTimeoutMs: 2000,
    });
    await tunnel.close();

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  }, 3000);

  // Regression (FIX 1): a non-JSON line before the JSON contract line must NOT
  // deadlock the port read. Before the fix, the unparseable first line was
  // re-found on every chunk and the promise never settled → openTunnel hung.
  it('resolves when a non-JSON line precedes the JSON contract line', async () => {
    const child = fakeForwardChildWithPrefix(agentPort, 'some startup warning\n');
    mockSpawn.mockReturnValue(child);

    const t = await tunnelMod.openTunnel('192.0.2.55', {
      user: 'sysadmin', remotePort: 9100, znvaultBin: 'znvault', readinessTimeoutMs: 2000,
    });

    expect(t.localPort).toBe(agentPort);
    await t.close();
  }, 5000);

  // Regression: the JSON contract line arriving split across two data chunks
  // must be reassembled and parsed correctly.
  it('resolves when the JSON contract line is split across two chunks', async () => {
    const child = fakeForwardChildSplit(agentPort);
    mockSpawn.mockReturnValue(child);

    const t = await tunnelMod.openTunnel('192.0.2.55', {
      user: 'sysadmin', remotePort: 9100, znvaultBin: 'znvault', readinessTimeoutMs: 2000,
    });

    expect(t.localPort).toBe(agentPort);
    await t.close();
  }, 5000);

  // Readiness timeout: a valid port is printed but /live never answers (no
  // server on that port). openTunnel must reject AND kill the child (close()
  // runs before throwing).
  it('rejects and kills the child when /live never answers', async () => {
    // Bind then immediately release a port so nothing is listening on it.
    const dead = http.createServer();
    const deadPort = await new Promise<number>((resolve) => {
      dead.listen(0, '127.0.0.1', () => {
        const p = (dead.address() as import('node:net').AddressInfo).port;
        dead.close(() => resolve(p));
      });
    });

    const child = fakeForwardChild(deadPort);
    mockSpawn.mockReturnValue(child);

    await expect(
      tunnelMod.openTunnel('192.0.2.55', {
        user: 'sysadmin', remotePort: 9100, znvaultBin: 'znvault', readinessTimeoutMs: 600,
      }),
    ).rejects.toThrow(/never answered/);
    expect(child.kill).toHaveBeenCalled();
  }, 3000);

  it('rejects and kills the child when /live returns invalid JSON', async () => {
    await new Promise<void>((resolve, reject) => {
      agent.close((error) => error ? reject(error) : resolve());
    });
    agent = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json');
    });
    await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r));
    agentPort = (agent.address() as import('node:net').AddressInfo).port;

    const child = fakeForwardChild(agentPort);
    mockSpawn.mockReturnValue(child);

    await expect(
      tunnelMod.openTunnel('192.0.2.55', {
        znvaultBin: 'znvault', readinessTimeoutMs: 600,
      }),
    ).rejects.toThrow(/\/live never answered/);
    expect(child.kill).toHaveBeenCalled();
  }, 3000);
});
