import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkHostReachable } from '../src/host-checks.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function finishRetrying<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('checkHostReachable health snapshot contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats a valid unhealthy HTTP 503 snapshot as transport-reachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, {
      status: 'unhealthy',
      version: '2.0.0',
      plugins: [{
        name: 'payara',
        version: '3.0.0',
        details: { running: false, ignored: 'not part of the core contract' },
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkHostReachable('127.0.0.1', 9100)).resolves.toEqual({
      host: '127.0.0.1',
      reachable: true,
      healthHttpStatus: 503,
      healthStatus: 'unhealthy',
      agentVersion: '2.0.0',
      pluginVersion: '3.0.0',
      pluginRunning: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'invalid JSON',
      response: () => new Response('not-json', { status: 503 }),
      error: /JSON|Unexpected token|Unexpected character/i,
    },
    {
      name: 'unknown agent version',
      response: () => jsonResponse(503, { status: 'unhealthy', version: 'unknown' }),
      error: /unknown version/i,
    },
    {
      name: 'contradictory status',
      response: () => jsonResponse(503, { status: 'healthy', version: '2.0.0' }),
      error: /contradicts HTTP 503/i,
    },
    {
      name: 'unexpected HTTP status',
      response: () => jsonResponse(500, { status: 'unhealthy', version: '2.0.0' }),
      error: /HTTP 500/i,
    },
  ])('fails closed after retries for $name', async ({ response, error }) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await finishRetrying(checkHostReachable('127.0.0.1', 9100));

    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(error);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps network failure distinct from a valid unhealthy snapshot', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(finishRetrying(checkHostReachable('127.0.0.1', 9100))).resolves.toEqual({
      host: '127.0.0.1',
      reachable: false,
      error: 'ECONNREFUSED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
