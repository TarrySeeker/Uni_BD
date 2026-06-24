import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * Юнит-тест конвейера runStorefront/handlePreflight (без БД).
 * Каталоговый handler не вызывается на путях ошибок (модуль/auth), а на успехе
 * мокается. rate-limit работает на in-memory mock (Redis нет).
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;

async function load() {
  vi.resetModules();
  return import('@/lib/storefront/response');
}

describe('storefront/response — конвейер', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog';
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
  });

  it('модуль catalog выключен → 404 module_disabled', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { runStorefront } = await load();
    const req = new Request('http://x/', { headers: { 'x-storefront-key': 'sk_secret' } });
    const res = await runStorefront(req, async () => NextResponse.json({ unreached: true }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('module_disabled');
  });

  it('нет ключа/origin → 401 unauthorized', async () => {
    const { runStorefront } = await load();
    const res = await runStorefront(new Request('http://x/'), async () =>
      NextResponse.json({ unreached: true }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('предъявлен неверный ключ → 403 forbidden', async () => {
    const { runStorefront } = await load();
    const req = new Request('http://x/', { headers: { 'x-storefront-key': 'wrong' } });
    const res = await runStorefront(req, async () => NextResponse.json({ unreached: true }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('валидный ключ → handler вызывается, CORS в ответе', async () => {
    const { runStorefront, jsonData } = await load();
    const req = new Request('http://x/', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await runStorefront(req, async ({ cors }) =>
      jsonData([1, 2], { count: 2 }, cors),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as { data: number[]; count: number };
    expect(body.data).toEqual([1, 2]);
    expect(body.count).toBe(2);
  });

  it('handlePreflight → 204 с Max-Age', async () => {
    const { handlePreflight } = await load();
    const req = new Request('http://x/', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://demo.com',
        'access-control-request-method': 'GET',
      },
    });
    const res = handlePreflight(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600');
  });
});
