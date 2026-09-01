import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  agentFetch,
  agentGet,
  agentPost,
  agentPostWithStatus,
  configureTLS,
  createDeploymentId,
  pollDeploymentStatus,
} from '../src/http-client.js';

const AUTH = { bearerToken: 'a'.repeat(43) };

describe('agentPost', () => {
  afterEach(() => {
    configureTLS({ verify: true, caCert: undefined, caCertPath: undefined });
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

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1/restart');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: '{}' });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe(`Bearer ${AUTH.bearerToken}`);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
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
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe(`Bearer ${AUTH.bearerToken}`);
  });

  it('treats a 409 as pollable only for the exact deployment identity', async () => {
    const wallClock = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Number.MAX_SAFE_INTEGER)
      .mockReturnValue(Number.MIN_SAFE_INTEGER);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Deployment in progress',
        deploymentId: 'operation-a',
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Deployment in progress',
        deploymentId: 'operation-a',
      }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(agentPostWithStatus(
      'http://127.0.0.1/deploy',
      {},
      30_000,
      AUTH,
      'operation-a',
    )).resolves.toMatchObject({
      ok: false,
      status: 409,
      inProgress: true,
      deploymentId: 'operation-a',
    });

    await expect(agentPostWithStatus(
      'http://127.0.0.1/deploy',
      {},
      30_000,
      AUTH,
      'operation-b',
    )).resolves.toMatchObject({
      ok: false,
      status: 409,
      inProgress: false,
      deploymentId: 'operation-a',
    });
    expect(wallClock).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      .get('x-znvault-deployment-id')).toBe('operation-a');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)))
      .toMatchObject({ deploymentId: 'operation-a' });
  });

  it('rejects a mismatched body and polling identity before sending the request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(agentPostWithStatus(
      'http://127.0.0.1/deploy',
      { deploymentId: 'operation-a' },
      30_000,
      AUTH,
      'operation-b',
    )).resolves.toEqual({
      ok: false,
      status: 0,
      inProgress: false,
      error: 'Deployment identity in request body does not match the polling identity',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a JSON object when deployment recovery is requested', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(agentPostWithStatus(
      'http://127.0.0.1/deploy',
      'not-an-object',
      30_000,
      AUTH,
      'operation-a',
    )).resolves.toEqual({
      ok: false,
      status: 0,
      inProgress: false,
      error: 'A deployment identity requires a JSON object request body',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains bearer authorization while polling deployment status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deploying: false,
        lastCompletedAt: 1,
        lastDeploymentId: 'operation-a',
        lastResult: { success: true, message: 'done' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollDeploymentStatus(
      'http://127.0.0.1/plugins/payara',
      'operation-a',
      { waitingForDeployment: vi.fn() },
      1_000,
      AUTH,
    );

    expect(result.success).toBe(true);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe(`Bearer ${AUTH.bearerToken}`);
  });

  it('keeps the legacy timestamp signature source-compatible but fails closed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollDeploymentStatus(
      'http://127.0.0.1/plugins/payara',
      Date.now(),
      { waitingForDeployment: vi.fn() },
      1_000,
      AUTH,
    )).resolves.toEqual({
      success: false,
      error: 'Deployment operation identity is required; timestamp polling is unsafe',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not accept another operation result even when its timestamp is newer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deploying: true,
        deploymentId: 'operation-b',
        lastDeploymentId: 'operation-b',
        lastCompletedAt: Number.MAX_SAFE_INTEGER,
        lastResult: { success: true, message: 'other deployment' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollDeploymentStatus(
      'http://127.0.0.1/plugins/payara',
      'operation-a',
      { waitingForDeployment: vi.fn() },
      1_000,
      AUTH,
    )).resolves.toEqual({
      success: false,
      error: 'A different deployment is in progress; refusing to use its result',
    });
  });

  it('fails closed when a later terminal receipt overwrote this operation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deploying: false,
        lastDeploymentId: 'operation-b',
        lastCompletedAt: Number.MAX_SAFE_INTEGER,
        lastResult: { success: true, message: 'later deployment' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollDeploymentStatus(
      'http://127.0.0.1/plugins/payara',
      'operation-a',
      { waitingForDeployment: vi.fn() },
      5,
      AUTH,
    )).resolves.toEqual({
      success: false,
      error: 'Timed out waiting for deployment to complete',
    });
  });

  it('matches by identity despite arbitrary client/server clock skew', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deploying: false,
        lastDeploymentId: 'operation-a',
        lastCompletedAt: 1,
        lastResult: { success: false, message: 'exact failure' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollDeploymentStatus(
      'http://127.0.0.1/plugins/payara',
      'operation-a',
      { waitingForDeployment: vi.fn() },
      1_000,
      AUTH,
    )).resolves.toMatchObject({
      success: false,
      error: 'exact failure',
      result: { success: false },
    });
  });

  it('generates distinct opaque deployment identities', () => {
    const first = createDeploymentId();
    const second = createDeploymentId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
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
      agentGet('https://host-a.test/status', 30_000, authA),
      agentGet('https://host-b.test/status', 30_000, authB),
    ]);

    const calls = new Map(fetchMock.mock.calls.map(([url, options]) => [url, options]));
    expect(new Headers(calls.get('https://host-a.test/status')?.headers).get('Authorization'))
      .toBe(`Bearer ${authA.bearerToken}`);
    expect(new Headers(calls.get('https://host-b.test/status')?.headers).get('Authorization'))
      .toBe(`Bearer ${authB.bearerToken}`);
  });

  it('refuses to send credentials over remote HTTP or unverified HTTPS', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(agentGet('http://host.test/status', 30_000, AUTH)).rejects.toThrow(
      'non-loopback HTTP'
    );

    configureTLS({ verify: false });
    await expect(agentGet('https://host.test/status', 30_000, AUTH)).rejects.toThrow(
      'TLS verification disabled'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the same auth and transport policy for binary uploads', async () => {
    const body = Buffer.from('war-bytes');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await agentFetch(
      'http://[::1]:9100/plugins/payara/deploy/upload',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      },
      AUTH,
    );

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(body);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe(`Bearer ${AUTH.bearerToken}`);
  });

  it('recognizes URL-canonicalized IPv4-mapped IPv6 loopback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await agentGet('http://[::ffff:127.0.0.2]:9100/health', 30_000, AUTH);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe(`Bearer ${AUTH.bearerToken}`);
  });

  it('rejects non-HTTP transports and caller-injected authorization', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(agentFetch('ftp://localhost/upload', {}, AUTH)).rejects.toThrow(
      'non-HTTP transport'
    );
    await expect(agentFetch(
      'https://host.test/upload',
      { headers: { Authorization: `Bearer ${AUTH.bearerToken}` } },
    )).rejects.toThrow('must be supplied through AgentRequestAuth');
    await expect(agentFetch(
      'https://host.test/upload',
      { dispatcher: { connect: { rejectUnauthorized: false } } } as RequestInit,
      AUTH,
    )).rejects.toThrow('TLS dispatchers are not allowed');
    await expect(agentFetch(
      'https://host.test/upload',
      { agent: { rejectUnauthorized: false } } as RequestInit,
      AUTH,
    )).rejects.toThrow('TLS dispatchers are not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('installs a controlled Undici dispatcher for a custom CA', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    configureTLS({ verify: true, caCert: 'test-ca', caCertPath: undefined });

    await agentGet('https://host.test/status', 30_000, AUTH);

    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).toBeDefined();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
});
