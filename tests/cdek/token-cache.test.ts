import { describe, it, expect, vi } from 'vitest';
import {
  createTokenCache,
  createMockTokenCache,
  MemoryTokenStore,
  tokenTtlFromExpiresIn,
  tokenCacheKey,
  CDEK_MOCK_TOKEN,
  type OAuthTokenResponse,
} from '@/lib/cdek/token-cache';

/**
 * Тесты кеша OAuth-токена (docs/08 §2.3, §4).
 *
 *  (а) MOCK-режим — фейк-токен без сети (всегда зелёный).
 *  (б) Чистые функции — TTL из expires_in, ключ кеша.
 *  (в) Реальный путь — ТОЛЬКО с замоканным fetch (vi.fn): кеш, TTL, single-flight,
 *      retry-friendly invalidate. Без реальной сети (окружение без неё).
 */

/** Фабрика замоканного fetch для /oauth/token; считает число обращений. */
function makeTokenFetch(resp: Partial<OAuthTokenResponse>, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(resp), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('cdek/token-cache — mock-режим', () => {
  it('createMockTokenCache отдаёт mock-token без сети', async () => {
    const cache = createMockTokenCache();
    await expect(cache.getToken()).resolves.toBe(CDEK_MOCK_TOKEN);
    expect(CDEK_MOCK_TOKEN).toBe('mock-token');
  });

  it('invalidate в mock — no-op, токен прежний', async () => {
    const cache = createMockTokenCache();
    await cache.invalidate();
    await expect(cache.getToken()).resolves.toBe('mock-token');
  });
});

describe('cdek/token-cache — чистые функции', () => {
  it('tokenTtlFromExpiresIn: expires_in − 60', () => {
    expect(tokenTtlFromExpiresIn(3599)).toBe(3539);
    expect(tokenTtlFromExpiresIn(3600)).toBe(3540);
  });

  it('tokenTtlFromExpiresIn: нижняя граница 60с', () => {
    expect(tokenTtlFromExpiresIn(90)).toBe(60); // 90-60=30 → 60
    expect(tokenTtlFromExpiresIn(10)).toBe(60);
  });

  it('tokenTtlFromExpiresIn: фоллбэк 3540 при отсутствии', () => {
    expect(tokenTtlFromExpiresIn(undefined)).toBe(3540);
    expect(tokenTtlFromExpiresIn(NaN)).toBe(3540);
  });

  it('tokenCacheKey — стабильный sha256-ключ по account', () => {
    const k = tokenCacheKey('acc-1');
    expect(k).toMatch(/^cdek:oauth:token:[0-9a-f]{64}$/);
    expect(tokenCacheKey('acc-1')).toBe(k); // детерминирован
    expect(tokenCacheKey('acc-2')).not.toBe(k);
  });
});

describe('cdek/token-cache — реальный путь (замоканный fetch)', () => {
  function makeCache(fetchImpl: typeof fetch, store = new MemoryTokenStore()) {
    return {
      store,
      cache: createTokenCache({
        baseUrl: 'https://api.edu.cdek.ru',
        account: 'acc-1',
        secret: 'sec-1',
        store,
        fetchImpl,
      }),
    };
  }

  it('добывает токен POST-ом на /v2/oauth/token (form-urlencoded)', async () => {
    const fetchImpl = makeTokenFetch({ access_token: 'tok-A', expires_in: 3599 });
    const { cache } = makeCache(fetchImpl);

    await expect(cache.getToken()).resolves.toBe('tok-A');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.edu.cdek.ru/v2/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toContain('grant_type=client_credentials');
    expect(init.body).toContain('client_id=acc-1');
    expect(init.body).toContain('client_secret=sec-1');
  });

  it('кеширует токен: второй getToken не ходит в сеть', async () => {
    const fetchImpl = makeTokenFetch({ access_token: 'tok-A', expires_in: 3599 });
    const { cache } = makeCache(fetchImpl);

    await cache.getToken();
    await cache.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('TTL по expires_in: после истечения добывает заново', async () => {
    const fetchImpl = makeTokenFetch({ access_token: 'tok-A', expires_in: 120 });
    const store = new MemoryTokenStore();
    const { cache } = makeCache(fetchImpl, store);

    await cache.getToken(); // ttl = 120-60 = 60с
    store.__advance(61_000); // сдвигаем часы за TTL
    await cache.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidate сбрасывает кеш → следующий getToken добывает свежий', async () => {
    const fetchImpl = makeTokenFetch({ access_token: 'tok-A', expires_in: 3599 });
    const { cache } = makeCache(fetchImpl);

    await cache.getToken();
    await cache.invalidate();
    await cache.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('single-flight: параллельные getToken дёргают /oauth/token один раз', async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const { cache } = makeCache(fetchImpl);

    const p1 = cache.getToken();
    const p2 = cache.getToken();
    const p3 = cache.getToken();

    // Дать микрозадачам прокрутиться (store.get async) — fetch стартует один раз.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch!(
      new Response(JSON.stringify({ access_token: 'tok-A', expires_in: 3599 }), { status: 200 }),
    );

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['tok-A', 'tok-A', 'tok-A']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ошибка авторизации (HTTP 400 без access_token) → CdekError', async () => {
    const fetchImpl = makeTokenFetch({ errors: [{ code: 'x', message: 'bad' }] } as never, 400);
    const { cache } = makeCache(fetchImpl);
    await expect(cache.getToken()).rejects.toMatchObject({
      name: 'CdekError',
      httpStatus: 400,
    });
  });

  it('single-flight освобождается после ошибки (повтор добывает заново)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'tok-B', expires_in: 3599 }), { status: 200 }),
      ) as unknown as typeof fetch;
    const { cache } = makeCache(fetchImpl);

    await expect(cache.getToken()).rejects.toMatchObject({ name: 'CdekError' });
    // in-flight сброшен → повтор делает новый запрос и получает токен.
    await expect(cache.getToken()).resolves.toBe('tok-B');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
