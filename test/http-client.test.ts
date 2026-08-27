import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentPost } from '../src/http-client.js';

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
});
