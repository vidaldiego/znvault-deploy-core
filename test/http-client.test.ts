import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  agentGet,
  agentPost,
  agentPostWithStatus,
  pollDeploymentStatus,
} from '../src/http-client.js';

const AUTH = { bearerToken: 'a'.repeat(43) };

describe('agentPost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses a caller-supplied lifecycle timeout', async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ restarted: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(agentPost('http://127.0.0.1/restart', {}, 300_000)).resolves.toEqual({
      restarted: true,
    });

    expect(timeout).toHaveBeenCalledWith(300_000);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1/restart',
      expect.objectContaining({ signal }),
    );
  });

  it('adds an in-memory bearer token without changing the URL or body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ restarted: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await agentPost('http://127.0.0.1/restart', {}, 30_000, AUTH);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1/restart',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${AUTH.bearerToken}`,
        }),
        body: '{}',
      }),
    );
  });

  it('rejects malformed bearer tokens before dispatch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      agentGet('http://127.0.0.1/status', 30_000, { bearerToken: 'short\nheader' }),
    ).rejects.toThrow('Invalid agent control-plane bearer token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies bearer authorization to status-aware POST requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ committed: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      agentPostWithStatus('http://127.0.0.1/deploy/chunk', {}, 30_000, AUTH),
    ).resolves.toEqual({ ok: true, data: { committed: true } });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${AUTH.bearerToken}`,
    });
  });

  it('retains bearer authorization while polling deployment status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deploying: false,
        lastCompletedAt: 200,
        lastResult: { success: true, message: 'done' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollDeploymentStatus(
      'http://127.0.0.1/plugins/payara',
      100,
      { waitingForDeployment: vi.fn() },
      1_000,
      AUTH,
    );

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${AUTH.bearerToken}`,
    });
  });

  it('does not cross per-host credentials during concurrent requests', async () => {
    const authA = { bearerToken: 'a'.repeat(43) };
    const authB = { bearerToken: 'b'.repeat(43) };
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ url }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([
      agentGet('http://host-a.test/status', 30_000, authA),
      agentGet('http://host-b.test/status', 30_000, authB),
    ]);

    const calls = new Map(fetchMock.mock.calls.map(([url, options]) => [url, options]));
    expect(calls.get('http://host-a.test/status')?.headers).toMatchObject({
      Authorization: `Bearer ${authA.bearerToken}`,
    });
    expect(calls.get('http://host-b.test/status')?.headers).toMatchObject({
      Authorization: `Bearer ${authB.bearerToken}`,
    });
  });
});
