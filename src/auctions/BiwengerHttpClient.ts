const API_URL = 'https://biwenger.as.com/api/v2';

export interface BiwengerHttpClientOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

function safePath(path: string): string {
  const pathname = path.split('?')[0];
  return /^\/(auth\/login|account|market|league\/\d+)$/.test(pathname) ? pathname : '/redacted';
}

export class BiwengerHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    detail?: string,
    readonly retryAfterMs = 500
  ) {
    super(`Biwenger ${method} ${path} failed ${status === undefined ? 'with network error or timeout' : `with HTTP ${status}`}${detail ? ` (${detail})` : ''}`);
    this.name = 'BiwengerHttpError';
  }
}

export class BiwengerHttpClient {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly fetcher: typeof fetch = fetch, options: BiwengerHttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    const attempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2147483647
      || !Number.isInteger(attempts) || attempts < 1) throw new RangeError('Invalid HTTP retry options');
    this.maxAttempts = Math.min(attempts, 3);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request(path: string, init: RequestInit): Promise<unknown> {
    const method = (init.method ?? 'GET').toUpperCase();
    const safeMethod = /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method) ? method : 'REDACTED';
    const errorPath = safePath(path);
    const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'X-Lang': 'es' });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.delete('X-Version');
    const canRetry = method === 'GET' || (method === 'POST' && path === '/auth/login');
    const attempts = canRetry ? this.maxAttempts : 1;

    for (let attempt = 1; ; attempt++) {
      if (init.signal?.aborted) throw new BiwengerHttpError(safeMethod, errorPath, undefined, false);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      let status: number | undefined;
      let retryAfter: string | null = null;
      try {
        const interrupted = new Promise<never>((_, reject) => {
          const abort = () => {
            controller.abort();
            reject(new BiwengerHttpError(safeMethod, errorPath, status, !init.signal?.aborted));
          };
          timer = setTimeout(abort, this.timeoutMs);
          abortListener = abort;
          init.signal?.addEventListener('abort', abort, { once: true });
        });
        return await Promise.race([interrupted, (async () => {
          const response = await this.fetcher(`${API_URL}${path}`, { ...init, method, headers, signal: controller.signal });
          status = response.status;
          retryAfter = response.headers.get('Retry-After');
          if (!response.ok) {
            await response.body?.cancel();
            const rawDelay = retryAfter === null ? NaN : /^\d+(\.\d+)?$/.test(retryAfter)
              ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
            const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? Math.min(rawDelay, 30000) : 500;
            throw new BiwengerHttpError(safeMethod, errorPath, status, status === 408 || status === 429 || status >= 500, undefined, delay);
          }
          const text = await response.text();
          if (!text) return {};
          try { return JSON.parse(text) as unknown; }
          catch { throw new BiwengerHttpError(safeMethod, errorPath, status, method === 'PUT', 'invalid JSON'); }
        })()]);
      } catch (cause) {
        const error = cause instanceof BiwengerHttpError ? cause
          : new BiwengerHttpError(safeMethod, errorPath, status, !init.signal?.aborted);
        if (!error.retryable || attempt >= attempts) throw error;
      } finally {
        clearTimeout(timer);
        if (abortListener) init.signal?.removeEventListener('abort', abortListener);
      }
      const fallback = 500 * 2 ** (attempt - 1);
      const raw = retryAfter === null ? NaN : /^\d+(\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      await this.sleep(Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30000) : fallback);
    }
  }
}
