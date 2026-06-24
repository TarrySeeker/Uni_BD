import { describe, it, expect, vi } from 'vitest';
import { CdekClient } from '@/lib/cdek/client';
import { CdekError } from '@/lib/cdek/errors';
import { getCdekConfig } from '@/lib/cdek/config';

/**
 * Тесты HTTP-клиента СДЭК (docs/08 §2.2). Только с замоканным fetch (vi.fn) —
 * без реальной сети. Проверяем: Bearer-заголовок, маппинг ошибки СДЭК в
 * CdekError, ретрай 401 (сброс токена + повтор), ретрай 5xx.
 */

/** Боевая конфигурация (ключи заданы → не mock). */
function realConfig() {
  return getCdekConfig({
    NODE_ENV: 'test',
    CDEK_ACCOUNT: 'acc-1',
    CDEK_SECRET: 'sec-1',
    CDEK_BASE_URL: 'https://api.edu.cdek.ru',
  });
}

/** Клиент с предустановленным mock-токеном (минуя /oauth/token). */
function makeClient(fetchImpl: typeof fetch) {
  let token = 'tok-1';
  const tokenCache = {
    getToken: vi.fn(async () => token),
    invalidate: vi.fn(async () => {
      token = 'tok-2'; // после сброса getToken вернёт свежий
    }),
  };
  const client = new CdekClient({ config: realConfig(), fetchImpl, tokenCache });
  return { client, tokenCache };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('cdek/client — авторизация и запрос', () => {
  it('добавляет Authorization: Bearer <token> и Accept', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    const res = await client.request('GET', '/v2/deliverypoints', { query: { city_code: 44 } });

    expect(res).toEqual({ ok: true });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.edu.cdek.ru/v2/deliverypoints?city_code=44');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.method).toBe('GET');
  });

  it('POST с json ставит Content-Type и сериализует тело', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entity: { uuid: 'u-1' } })) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    await client.request('POST', '/v2/orders', { json: { number: 'ord-1' } });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ number: 'ord-1' });
  });

  it('отбрасывает undefined query-параметры', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    await client.request('GET', '/v2/deliverypoints', {
      query: { city_code: 44, postal_code: undefined },
    });
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.edu.cdek.ru/v2/deliverypoints?city_code=44');
  });

  it('конструктор без ключей кидает CdekError (mock-режим клиент не строит)', () => {
    const mockCfg = getCdekConfig({ NODE_ENV: 'test' });
    expect(() => new CdekClient({ config: mockCfg })).toThrow(CdekError);
  });
});

describe('cdek/client — обработка ошибок', () => {
  it('HTTP ≥ 400 маппится в CdekError с httpStatus и cdekErrors', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ code: 'v2_field_invalid', message: 'bad recipient' }] }, 400),
    ) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    await expect(client.request('POST', '/v2/orders', { json: {} })).rejects.toMatchObject({
      name: 'CdekError',
      httpStatus: 400,
    });
    try {
      await client.request('POST', '/v2/orders', { json: {} });
    } catch (e) {
      const err = e as CdekError;
      expect(err.cdekErrors).toEqual([{ code: 'v2_field_invalid', message: 'bad recipient' }]);
    }
  });

  it('сетевая ошибка после исчерпания ретраев → CdekError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    await expect(
      client.request('GET', '/v2/deliverypoints', { maxNetworkRetries: 0 }),
    ).rejects.toMatchObject({ name: 'CdekError', code: 'cdek_network_error' });
  });
});

describe('cdek/client — ретраи', () => {
  it('ретрай на 401: invalidateToken + один повтор со свежим токеном', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [] }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true })) as unknown as typeof fetch;
    const { client, tokenCache } = makeClient(fetchImpl);

    const res = await client.request('GET', '/v2/orders');

    expect(res).toEqual({ ok: true });
    expect(tokenCache.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Второй запрос ушёл со свежим токеном tok-2.
    const [, init2] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(init2.headers.Authorization).toBe('Bearer tok-2');
  });

  it('401 повторяется ровно один раз (второй 401 пробрасывается)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [] }, 401)) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    await expect(client.request('GET', '/v2/orders')).rejects.toMatchObject({
      name: 'CdekError',
      httpStatus: 401,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // оригинал + один повтор
  });

  it('ретрай на 5xx: повторяет и в итоге возвращает успех', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true })) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    const res = await client.request('GET', '/v2/orders', { maxNetworkRetries: 2 });
    expect(res).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('5xx после исчерпания ретраев → CdekError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errors: [] }, 500)) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);

    await expect(
      client.request('GET', '/v2/orders', { maxNetworkRetries: 1 }),
    ).rejects.toMatchObject({ name: 'CdekError', httpStatus: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // оригинал + 1 ретрай
  });
});
