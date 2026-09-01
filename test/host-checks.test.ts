import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkHostReachable, triggerPluginUpdate } from '../src/host-checks.js';

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

describe('triggerPluginUpdate exact receipt contract', () => {
  const REQUEST = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    package: '@zincapp/znvault-plugin-payara',
    expectedCurrentVersion: '3.0.0',
    expectedVersion: '3.0.1',
  } as const;

  const requestedAt = '2026-09-01T01:00:00.000Z';
  const startedAt = '2026-09-01T01:00:01.000Z';
  const finishedAt = '2026-09-01T01:00:02.000Z';

  const pending = {
    status: 'pending',
    requestId: REQUEST.requestId,
    package: REQUEST.package,
    previousVersion: REQUEST.expectedCurrentVersion,
    targetVersion: REQUEST.expectedVersion,
    requestedAt,
    pollPath: `/plugins/update/${REQUEST.requestId}`,
  } as const;

  const succeeded = {
    status: 'succeeded',
    requestId: REQUEST.requestId,
    package: REQUEST.package,
    previousVersion: REQUEST.expectedCurrentVersion,
    targetVersion: REQUEST.expectedVersion,
    newVersion: REQUEST.expectedVersion,
    installedVersion: REQUEST.expectedVersion,
    updated: 1,
    willRestart: true,
    requestedAt,
    startedAt,
    finishedAt,
  } as const;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('submits one exact operation and polls only its UUID to a terminal receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, pending))
      .mockResolvedValueOnce(jsonResponse(202, pending))
      .mockResolvedValueOnce(jsonResponse(200, succeeded));
    vi.stubGlobal('fetch', fetchMock);

    const result = triggerPluginUpdate(
      '127.0.0.1',
      9100,
      false,
      'payara',
      REQUEST,
      undefined,
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({
      success: true,
      response: {
        requestId: REQUEST.requestId,
        updated: 1,
        willRestart: true,
        results: [{
          package: REQUEST.package,
          previousVersion: REQUEST.expectedCurrentVersion,
          newVersion: REQUEST.expectedVersion,
          success: true,
        }],
        timestamp: finishedAt,
        requestedAt,
        startedAt,
        finishedAt,
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      ...REQUEST,
    });
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `http://127.0.0.1:9100/plugins/update/${REQUEST.requestId}`,
      `http://127.0.0.1:9100/plugins/update/${REQUEST.requestId}`,
    ]);
  });

  it('recovers an ambiguous POST transport timeout only through the same UUID', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('request timeout'))
      .mockResolvedValueOnce(jsonResponse(200, succeeded));
    vi.stubGlobal('fetch', fetchMock);

    await expect(triggerPluginUpdate(
      '127.0.0.1', 9100, false, 'payara', REQUEST,
    )).resolves.toMatchObject({ success: true });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://127.0.0.1:9100/plugins/update/${REQUEST.requestId}`
    );
  });

  it('accepts an exact durable GET no-op without restart', async () => {
    const noOpRequest = {
      ...REQUEST,
      expectedCurrentVersion: REQUEST.expectedVersion,
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, {
        ...pending,
        previousVersion: REQUEST.expectedVersion,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ...succeeded,
        previousVersion: REQUEST.expectedVersion,
        updated: 0,
        willRestart: false,
      })));

    await expect(triggerPluginUpdate(
      '127.0.0.1', 9100, false, 'payara', noOpRequest,
    )).resolves.toMatchObject({
      success: true,
      response: { updated: 0, willRestart: false },
    });
  });

  it('rejects an exact-looking terminal POST because only GET is durable evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, succeeded));
    vi.stubGlobal('fetch', fetchMock);

    await expect(triggerPluginUpdate(
      '127.0.0.1', 9100, false, 'payara', REQUEST,
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('durable GET receipt'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'another request UUID',
      response: { ...succeeded, requestId: '123e4567-e89b-42d3-b456-426614174000' },
    },
    {
      name: 'another plugin',
      response: { ...succeeded, package: '@scope/other' },
    },
    {
      name: 'wrong installed version',
      response: { ...succeeded, newVersion: '3.0.2' },
    },
    {
      name: 'inconsistent restart claim',
      response: { ...succeeded, willRestart: false },
    },
    {
      name: 'normalized but impossible receipt date',
      response: { ...succeeded, finishedAt: '2026-02-30T01:00:02.000Z' },
    },
  ])('fails closed for $name success receipts', async ({ response }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, response)));

    await expect(triggerPluginUpdate(
      '127.0.0.1',
      9100,
      false,
      'payara',
      REQUEST,
      undefined,
    )).resolves.toMatchObject({ success: false });
  });

  it('returns a correlated terminal helper failure without polling or restart', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, {
      status: 'failed',
      code: 'PLUGIN_INSTALL_FAILED',
      error: 'root-owned install failed',
      requestId: REQUEST.requestId,
      package: REQUEST.package,
      previousVersion: REQUEST.expectedCurrentVersion,
      targetVersion: REQUEST.expectedVersion,
      installedVersion: REQUEST.expectedCurrentVersion,
      willRestart: false,
      requestedAt,
      startedAt,
      finishedAt,
    })));

    await expect(triggerPluginUpdate(
      '127.0.0.1', 9100, false, 'payara', REQUEST,
    )).resolves.toEqual({ success: false, error: 'root-owned install failed' });
  });

  it('rejects an invalid exact update before network I/O', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(triggerPluginUpdate(
      '127.0.0.1',
      9100,
      false,
      'payara',
      {
        requestId: 'not-a-uuid',
        package: '',
        expectedCurrentVersion: 'range-or-tag',
        expectedVersion: 'not-semver',
      },
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Exact request UUID'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
