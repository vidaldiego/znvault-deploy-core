// Path: test/haproxy.test.ts
// Unit tests for HAProxy drain/ready module

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HAProxyConfig } from '../src/types.js';

/** The node execFile callback shape used by the mocked child_process. */
type ExecFileCb = (error: Error | null, stdout: string, stderr: string) => void;

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Import after mocking
const {
  sshExec,
  setServerState,
  drainServer,
  readyServer,
  testHAProxyConnectivity,
  getUnmappedHosts,
} = await import('../src/haproxy.js');

function makeConfig(overrides: Partial<HAProxyConfig> = {}): HAProxyConfig {
  return {
    hosts: ['198.51.100.20', '198.51.100.21', '198.51.100.23'],
    backend: 'api_servers',
    serverMap: {
      '192.0.2.10': 'server1',
      '192.0.2.11': 'server2',
    },
    ...overrides,
  };
}

describe('sshExec', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('should execute SSH command and return success', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, 'ok\n', '');
      return { on: vi.fn() };
    });

    const result = await sshExec('1.2.3.4', 'admin', 22, 'echo ok', 5000);

    expect(result.success).toBe(true);
    expect(result.host).toBe('1.2.3.4');
    expect(result.stdout).toBe('ok');
  });

  it('should return error on SSH failure', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(new Error('Connection refused'), '', 'ssh: connect to host 1.2.3.4 port 22: Connection refused');
      return { on: vi.fn() };
    });

    const result = await sshExec('1.2.3.4', 'admin', 22, 'echo ok', 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection refused');
  });

  it('should pass correct SSH arguments', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    await sshExec('10.0.0.1', 'myuser', 2222, 'ls', 8000);

    expect(mockExecFile).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining([
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-p', '2222',
        'myuser@10.0.0.1',
        'ls',
      ]),
      expect.objectContaining({ timeout: 8000 }),
      expect.any(Function),
    );
  });

  it('should use stderr for error message when available', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(new Error('exit code 1'), '', 'Permission denied (publickey)');
      return { on: vi.fn() };
    });

    const result = await sshExec('1.2.3.4', 'admin', 22, 'echo ok', 5000);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied (publickey)');
  });

  it.each([
    ['host', '-oProxyCommand=touch /tmp/owned', 'admin', 22, 5000, 'host contains unsupported characters'],
    ['user', '1.2.3.4', '-oProxyCommand=touch /tmp/owned', 22, 5000, 'user contains unsupported characters'],
    ['port', '1.2.3.4', 'admin', 0, 5000, 'port must be an integer'],
    ['timeout', '1.2.3.4', 'admin', 22, Number.NaN, 'timeout must be a positive integer'],
  ])('rejects an unsafe %s before starting ssh', (_field, host, user, port, timeout, error) => {
    expect(() => sshExec(host, user, port, 'echo ok', timeout)).toThrow(error);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('setServerState', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('should run drain command on all HAProxy hosts in parallel', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await setServerState(config, '192.0.2.10', 'drain');

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(3);
    // Verify the socat command was constructed correctly
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('set server api_servers/server1 state drain');
    expect(command).toContain("sudo socat stdio '/run/haproxy/admin.sock'");
  });

  it('should use sudo by default', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig();
    await setServerState(config, '192.0.2.10', 'drain');

    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('| sudo socat stdio');
  });

  it('should skip sudo when sudo is false', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig({ sudo: false });
    await setServerState(config, '192.0.2.10', 'drain');

    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).not.toContain('sudo');
    expect(command).toContain('| socat stdio');
  });

  it('should return failure if host not in serverMap', async () => {
    const config = makeConfig();
    const result = await setServerState(config, '10.0.0.99', 'drain');

    expect(result.success).toBe(false);
    expect(result.results[0]!.error).toContain('No HAProxy server mapping');
  });

  it('should return failure if any HAProxy host fails', async () => {
    let callIndex = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      callIndex++;
      if (callIndex === 2) {
        cb(new Error('timeout'), '', 'Connection timed out');
      } else {
        cb(null, '', '');
      }
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await setServerState(config, '192.0.2.10', 'drain');

    expect(result.success).toBe(false);
    expect(result.results.filter(r => r.success)).toHaveLength(2);
    expect(result.results.filter(r => !r.success)).toHaveLength(1);
  });

  it('should use custom config values', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig({
      user: 'root',
      sshPort: 2222,
      socketPath: '/var/run/haproxy.sock',
      sshTimeout: 20000,
    });

    await setServerState(config, '192.0.2.10', 'ready');

    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    expect(firstCallArgs).toContain('-p');
    expect(firstCallArgs).toContain('2222');
    expect(firstCallArgs).toContain('root@198.51.100.20');
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('/var/run/haproxy.sock');
    expect(command).toContain('state ready');
  });

  it.each([
    {
      field: 'backend',
      config: makeConfig({ backend: 'api_servers; touch /tmp/owned' }),
      error: 'backend contains unsupported characters',
    },
    {
      field: 'server name',
      config: makeConfig({
        serverMap: { '192.0.2.10': 'server1$(touch /tmp/owned)' },
      }),
      error: 'server name contains unsupported characters',
    },
    {
      field: 'socketPath',
      config: makeConfig({
        socketPath: '/run/haproxy/admin.sock; touch /tmp/owned',
      }),
      error: 'socketPath must be an absolute shell-safe path',
    },
  ])('rejects an unsafe $field before starting any SSH process', async ({ config, error }) => {
    await expect(
      setServerState(config, '192.0.2.10', 'drain')
    ).rejects.toThrow(error);

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('validates every HAProxy SSH destination before starting any process', async () => {
    const config = makeConfig({
      hosts: ['198.51.100.20', '-oProxyCommand=touch /tmp/owned'],
      user: 'testuser',
    });

    await expect(
      setServerState(config, '192.0.2.10', 'drain')
    ).rejects.toThrow('SSH host contains unsupported characters');

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it.each([
    { hosts: [], error: 'must contain at least one destination' },
    { hosts: ['198.51.100.20', '198.51.100.20'], error: 'must not contain duplicates' },
  ])('rejects an invalid HAProxy SSH host set before claiming success', async ({ hosts, error }) => {
    const config = makeConfig({ hosts });

    await expect(
      setServerState(config, '192.0.2.10', 'drain')
    ).rejects.toThrow(error);

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('drainServer / readyServer', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });
  });

  it('drainServer should call setServerState with drain', async () => {
    const config = makeConfig();
    const result = await drainServer(config, '192.0.2.10');

    expect(result.success).toBe(true);
    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('state drain');
  });

  it('readyServer should call setServerState with ready', async () => {
    const config = makeConfig();
    const result = await readyServer(config, '192.0.2.11');

    expect(result.success).toBe(true);
    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('state ready');
    expect(command).toContain('server2');
  });
});

describe('testHAProxyConnectivity', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('should SSH to all HAProxy hosts and check connectivity', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, 'ok', '');
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await testHAProxyConnectivity(config);

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('should report failure when a host is unreachable', async () => {
    let callIndex = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      callIndex++;
      if (callIndex === 3) {
        cb(new Error('timeout'), '', 'Connection timed out');
      } else {
        cb(null, 'ok', '');
      }
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await testHAProxyConnectivity(config);

    expect(result.success).toBe(false);
    expect(result.results.filter(r => !r.success)).toHaveLength(1);
  });
});

describe('getUnmappedHosts', () => {
  it('should return hosts without serverMap entries', () => {
    const config = makeConfig();
    const unmapped = getUnmappedHosts(config, [
      '192.0.2.10', // mapped
      '192.0.2.11', // mapped
      '192.0.2.12', // NOT mapped
    ]);

    expect(unmapped).toEqual(['192.0.2.12']);
  });

  it('should return empty array when all hosts are mapped', () => {
    const config = makeConfig();
    const unmapped = getUnmappedHosts(config, ['192.0.2.10', '192.0.2.11']);

    expect(unmapped).toEqual([]);
  });

  it('should return all hosts when serverMap is empty', () => {
    const config = makeConfig({ serverMap: {} });
    const unmapped = getUnmappedHosts(config, ['192.0.2.10', '192.0.2.11']);

    expect(unmapped).toEqual(['192.0.2.10', '192.0.2.11']);
  });
});
