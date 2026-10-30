import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BiwengerHttpClient,
  BiwengerHttpError,
  type BiwengerHttpClientOptions
} from '../../src/auctions/BiwengerHttpClient.js';

const BASE = 'https://biwenger.as.com/api/v2';
const secret = 'private-token-password';

function json(body: unknown = { ok: true }, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(options: BiwengerHttpClientOptions = {}) {
  const fetcher = vi.fn<typeof fetch>();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  return { fetcher, sleep, client: new BiwengerHttpClient(fetcher, { sleep, ...options }) };
}

async function getError(promise: Promise<unknown>): Promise<BiwengerHttpError> {
  const error: unknown = await promise.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(BiwengerHttpError);
  return error as BiwengerHttpError;
}

describe('BiwengerHttpClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['record', 'headers', 'tuples'])('merges %s headers and always removes X-Version', async (kind) => {
    const entries: [string, string][] = [['Authorization', `Bearer ${secret}`], ['x-version', '123']];
    const headers: HeadersInit = kind === 'headers' ? new Headers(entries)
      : kind === 'tuples' ? entries : Object.fromEntries(entries);
    const { fetcher, client } = setup();
    fetcher.mockResolvedValue(json({ data: [1, 2] }));

    await expect(client.request('/account', { headers })).resolves.toEqual({ data: [1, 2] });

    expect(fetcher).toHaveBeenCalledWith(`${BASE}/account`, expect.objectContaining({ method: 'GET' }));
    const sent = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(sent.get('Accept')).toBe('application/json');
    expect(sent.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(sent.get('X-Lang')).toBe('es');
    expect(sent.get('Authorization')).toBe(`Bearer ${secret}`);
    expect(sent.has('X-Version')).toBe(false);
    expect(new Headers(headers).has('X-Version')).toBe(true);
  });

  it('preserves the path, body and caller headers on every login attempt', async () => {
    const { fetcher, client } = setup();
    fetcher.mockRejectedValueOnce(new TypeError(secret)).mockResolvedValue(json({ token: secret }));
    const body = JSON.stringify({ password: secret });

    await expect(client.request('/auth/login', { method: 'post', body })).resolves.toEqual({ token: secret });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe(`${BASE}/auth/login`);
      expect(init).toMatchObject({ method: 'POST', body });
    }
  });

  it.each([408, 429, 500, 502, 503, 504, 599])('bounds transient HTTP %i to three attempts', async (status) => {
    const { fetcher, sleep, client } = setup();
    fetcher.mockImplementation(async () => new Response(secret, { status }));

    const error = await getError(client.request(`/league/12?token=${secret}`, { method: 'GET' }));

    expect(error).toMatchObject({ retryable: true, method: 'GET', path: '/league/12', status });
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.stack).not.toContain(secret);
    expect(error).not.toHaveProperty('cause');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409, 422])('does not retry HTTP %i even with a non-JSON body', async (status) => {
    const { fetcher, sleep, client } = setup();
    fetcher.mockResolvedValue(new Response(secret, { status }));

    expect(await getError(client.request('/auth/login', { method: 'POST' })))
      .toMatchObject({ status, retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['2', 2000], ['1000', 30_000], ['0', 0], ['-1', 500], ['invalid', 500]
  ])('handles Retry-After %s within the 30-second limit', async (value, delay) => {
    const { fetcher, sleep, client } = setup();
    fetcher.mockResolvedValueOnce(json({}, 429, { 'Retry-After': String(value) })).mockResolvedValue(json());

    await client.request('/account', {});

    expect(sleep).toHaveBeenCalledExactlyOnceWith(delay);
  });

  it('supports HTTP-date Retry-After values', async () => {
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const { fetcher, sleep, client } = setup();
    fetcher.mockResolvedValueOnce(json({}, 503, { 'Retry-After': 'Fri, 30 Oct 2026 12:00:08 GMT' }))
      .mockResolvedValue(json());

    await client.request('/account', {});

    expect(sleep).toHaveBeenCalledExactlyOnceWith(8000);
  });

  it('sanitizes raw network exceptions and respects a smaller attempt budget', async () => {
    const { fetcher, sleep, client } = setup({ maxAttempts: 2 });
    fetcher.mockRejectedValue(new Error(`https://example.com/?token=${secret}`));

    const error = await getError(client.request(`/account?token=${secret}`, {}));

    expect(error).toMatchObject({ retryable: true, method: 'GET', path: '/account', status: undefined });
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(error).not.toHaveProperty('cause');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('caps even a larger configured attempt budget at three', async () => {
    const { fetcher, client } = setup({ maxAttempts: 50 });
    fetcher.mockRejectedValue(new Error(secret));
    await getError(client.request('/account', {}));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['PUT', 'POST', 'DELETE', 'PATCH'])('never automatically retries non-login %s', async (method) => {
    const { fetcher, sleep, client } = setup();
    fetcher.mockRejectedValue(new Error(secret));

    expect(await getError(client.request('/league/12', { method }))).toMatchObject({ retryable: true, method });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([408, 429, 503])('does not retry an ambiguous PUT with HTTP %i', async (status) => {
    const { fetcher, sleep, client } = setup();
    fetcher.mockResolvedValue(json({ secret }, status, { 'Retry-After': '30' }));

    expect(await getError(client.request('/league/12', { method: 'PUT', body: secret })))
      .toMatchObject({ retryable: true, status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT'])('reports invalid JSON on %s without leaking response content', async (method) => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValue(new Response(`not-json-${secret}`));

    const error = await getError(client.request('/league/12', { method }));

    expect(error).toMatchObject({ retryable: method === 'PUT', status: 200 });
    expect(error.message).toContain('invalid JSON');
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts empty successful responses like the existing service', async () => {
    const { fetcher, client } = setup();
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client.request('/league/12', { method: 'PUT' })).resolves.toEqual({});
  });

  it('retries failures while reading a successful response body', async () => {
    const { fetcher, client } = setup();
    const response = json();
    vi.spyOn(response, 'text').mockRejectedValue(new Error(secret));
    fetcher.mockResolvedValueOnce(response).mockResolvedValue(json());
    await expect(client.request('/account', {})).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('times out and aborts a stalled PUT fetch at the default 15 seconds without retrying', async () => {
    const { fetcher, sleep, client } = setup();
    fetcher.mockImplementation(() => new Promise(() => {}));
    const result = getError(client.request('/league/12', { method: 'PUT' }));
    const signal = fetcher.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({ retryable: true });
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses a single deadline for fetch plus body and a fresh deadline for a login retry', async () => {
    const { fetcher, client } = setup({ timeoutMs: 100 });
    const stalled = json();
    vi.spyOn(stalled, 'text').mockImplementation(() => new Promise(() => {}));
    fetcher.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return stalled;
    }).mockResolvedValue(json({ token: 'ok' }));
    const result = client.request('/auth/login', { method: 'POST' });

    await vi.advanceTimersByTimeAsync(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ token: 'ok' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]?.signal).not.toBe(fetcher.mock.calls[1]?.[1]?.signal);
  });

  it('bounds repeated timeouts to three attempts', async () => {
    const { fetcher, client } = setup({ timeoutMs: 10 });
    fetcher.mockImplementation(() => new Promise(() => {}));
    const result = getError(client.request('/account', {}));
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not retry an explicit caller abort or expose its reason', async () => {
    const { fetcher, client } = setup();
    const controller = new AbortController();
    fetcher.mockImplementation(() => new Promise(() => {}));
    const result = getError(client.request('/account', { signal: controller.signal }));
    controller.abort(new Error(secret));
    const error = await result;
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not fetch with an already aborted caller signal', async () => {
    const { fetcher, client } = setup();
    const controller = new AbortController();
    controller.abort(secret);
    expect(await getError(client.request('/account', { signal: controller.signal })))
      .toMatchObject({ retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts unfamiliar paths and invalid methods from errors', async () => {
    const { fetcher, client } = setup();
    fetcher.mockRejectedValue(new Error(secret));
    const error = await getError(client.request(`/unknown/${secret}`, { method: secret }));
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(secret);
  });

  it.each([
    { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 31 },
    { maxAttempts: 0 }, { maxAttempts: 1.5 }, { maxAttempts: Infinity }
  ])('rejects invalid bounded transport options %j', (options) => {
    expect(() => setup(options)).toThrow(RangeError);
  });

  it('uses the default fetch dependency and default retry sleep with fake timers', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValue(json());
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = new BiwengerHttpClient().request('/account', {});
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toEqual({ ok: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
