import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * SECURITY-тест (волна 4, баг A): ключ rate-limit витрины НЕ должен зависеть от
 * НЕвалидированного клиентского заголовка X-Api-Key / X-Storefront-Key.
 *
 * Прежнее поведение (баг): rateKey брал ЛЮБОЙ непустой X-Api-Key как идентификатор
 * ведра (`storefront:key:<ключ>`) БЕЗ сверки с STOREFRONT_API_KEYS. Атакующий,
 * авторизуясь по разрешённому Origin (origin-путь), на каждый запрос подставлял
 * НОВЫЙ мусорный X-Api-Key → каждый запрос попадал в СВЕЖЕЕ ведро (count=0) →
 * лимит публичного POST (cart/quote, orders, delivery, payments/init) НИКОГДА не
 * срабатывал. Это обход abuse-защиты.
 *
 * Фикс: ведро по ключу — ТОЛЬКО когда auth.via==='key' (ключ совпал с конфигом).
 * Иначе (origin/mock/невалидный ключ) — ведро по ВАЛИДИРОВАННОМУ IP
 * (normalizeClientIp), независимо от подставленного клиентом X-Api-Key.
 *
 * Тест без БД: rate-limit на in-memory backend (REDIS_URL не задан).
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;
const ORIGINAL_REDIS = process.env.REDIS_URL;

async function load() {
  vi.resetModules();
  return import('@/lib/storefront/response');
}

/** Хелпер: прогон N запросов через конвейер, возвращает массив статусов. */
async function runMany(
  runStorefront: (
    req: Request,
    handler: (ctx: { cors: Record<string, string> }) => Promise<NextResponse>,
  ) => Promise<NextResponse>,
  makeReq: (i: number) => Request,
  n: number,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await runStorefront(makeReq(i), async () =>
      NextResponse.json({ ok: true }),
    );
    statuses.push(res.status);
  }
  return statuses;
}

describe('storefront/response — rateKey не обходится ротацией X-Api-Key (баг A)', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog';
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = 'https://demo.com';
    // Низкий порог окна, чтобы тест был быстрым (override через создание лимитера
    // мы не делаем; вместо этого опираемся на штатный STOREFRONT_RATE_LIMIT=600).
    delete process.env.REDIS_URL; // in-memory backend
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
    if (ORIGINAL_REDIS === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS;
  });

  it('SECURITY: origin-авторизация + РОТАЦИЯ мусорного X-Api-Key → один IP-bucket, лимит срабатывает (429)', async () => {
    const { runStorefront } = await load();
    // 601 запросов (>600) с РАЗНЫМ мусорным X-Api-Key и одним и тем же IP.
    // Авторизация — по разрешённому Origin (origin-путь), ключ невалиден.
    const statuses = await runMany(
      runStorefront,
      (i) =>
        new Request('http://x/', {
          headers: {
            origin: 'https://demo.com',
            'x-api-key': `junk-${i}`, // мусор, не совпадает с sk_secret
            'x-forwarded-for': '203.0.113.7',
          },
        }),
      601,
    );
    // На старом коде ВСЕ 601 были бы 200 (каждый junk-ключ → своё ведро).
    // На фиксе: все попадают в один storefront:ip:203.0.113.7 → последний 429.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('контроль: стабильный ВАЛИДНЫЙ ключ (via=key) лимитируется по ключу (429)', async () => {
    const { runStorefront } = await load();
    const statuses = await runMany(
      runStorefront,
      () =>
        new Request('http://x/', {
          headers: { 'x-storefront-key': 'sk_secret' }, // валидный → via=key
        }),
      601,
    );
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('контроль: РАЗНЫЕ IP (origin-авторизация) → РАЗНЫЕ вёдра, лимит на один IP не задевает другой', async () => {
    const { runStorefront } = await load();
    // 600 запросов с одного IP (заполняем его ведро под порог), затем 1 запрос
    // с ДРУГОГО IP — он должен пройти (200), т.к. ведро у него своё.
    await runMany(
      runStorefront,
      () =>
        new Request('http://x/', {
          headers: { origin: 'https://demo.com', 'x-forwarded-for': '203.0.113.10' },
        }),
      600,
    );
    const { runStorefront: rs2 } = { runStorefront };
    const res = await rs2(
      new Request('http://x/', {
        headers: { origin: 'https://demo.com', 'x-forwarded-for': '203.0.113.11' },
      }),
      async () => NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(200);
  });
});
