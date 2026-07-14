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

/**
 * 7a security-medium (cors-credentials): credentialed account/*-роуты НЕ должны
 * выдавать Access-Control-Allow-Credentials:true произвольному/несконфигурированному
 * origin. Проверяем на конвейере runStorefront/handlePreflight с credentialed=true.
 */
describe('storefront/response — credentialed CORS (account/*)', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog,account';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
  });

  it('mock-режим (ничего не настроено): сторонний origin → эхо, но БЕЗ Allow-Credentials', async () => {
    process.env.STOREFRONT_API_KEYS = '';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    const { runStorefront, jsonData } = await load();
    const req = new Request('http://x/', { headers: { origin: 'https://evil.com' } });
    const res = await runStorefront(
      req,
      async ({ cors }) => jsonData({ ok: true }, {}, cors),
      { module: 'account', credentialed: true },
    );
    expect(res.status).toBe(200);
    // Стороннему сайту credentialed-ответ НЕ отдаём.
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('сконфигурированный origin → Allow-Credentials:true (штатный поток цел)', async () => {
    process.env.STOREFRONT_API_KEYS = '';
    process.env.STOREFRONT_ALLOWED_ORIGINS = 'https://shop.com';
    const { runStorefront, jsonData } = await load();
    const req = new Request('http://x/', { headers: { origin: 'https://shop.com' } });
    const res = await runStorefront(
      req,
      async ({ cors }) => jsonData({ ok: true }, {}, cors),
      { module: 'account', credentialed: true },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.com');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('credentialed preflight: сторонний origin в mock → БЕЗ Allow-Credentials', async () => {
    process.env.STOREFRONT_API_KEYS = '';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    const { handlePreflight } = await load();
    const req = new Request('http://x/', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.com',
        'access-control-request-method': 'POST',
      },
    });
    const res = handlePreflight(req, 'GET, POST, OPTIONS', true);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('credentialed preflight: сконфигурированный origin → Allow-Credentials:true', async () => {
    process.env.STOREFRONT_API_KEYS = '';
    process.env.STOREFRONT_ALLOWED_ORIGINS = 'https://shop.com';
    const { handlePreflight } = await load();
    const req = new Request('http://x/', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://shop.com',
        'access-control-request-method': 'POST',
      },
    });
    const res = handlePreflight(req, 'GET, POST, OPTIONS', true);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('НЕ-auth роут (credentialed не задан): beacon-поток цел — Allow-Credentials:true при origin', async () => {
    process.env.STOREFRONT_API_KEYS = '';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    const { runStorefront, jsonData } = await load();
    const req = new Request('http://x/', { headers: { origin: 'https://demo.com' } });
    const res = await runStorefront(req, async ({ cors }) => jsonData({ ok: true }, {}, cors));
    expect(res.status).toBe(200);
    // Публичные роуты не ослаблены: origin echo + credentials сохранены (beacon).
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://demo.com');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});
