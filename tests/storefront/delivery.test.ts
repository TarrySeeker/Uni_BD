import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Конвейерные тесты storefront-роутов доставки СДЭК (docs/08 §6, пакет E).
 * Сети/БД нет: СДЭК в mock-режиме (пустые CDEK_*), расчёт по формуле §5.3,
 * ПВЗ — из фикстур. Проверяем:
 *   • модуль cdek выключен → 404 module_disabled (оба роута);
 *   • без auth → 401;
 *   • GET /pvz → детерминированные фикстуры в DTO (без внутренних полей);
 *   • POST /calculate → mock-расчёт детерминирован, DTO { tariffCode, cost, ... };
 *   • anti-tamper: from_location из тела ИГНОРИРУЕТСЯ (серверный CDEK_FROM_*).
 */

const ORIGINAL = {
  modules: process.env.ADMIK_MODULES,
  keys: process.env.STOREFRONT_API_KEYS,
  origins: process.env.STOREFRONT_ALLOWED_ORIGINS,
  account: process.env.CDEK_ACCOUNT,
  secret: process.env.CDEK_SECRET,
  from: process.env.CDEK_FROM_LOCATION_CODE,
};

const KEY = 'sk_secret';

function setEnv(modules: string) {
  process.env.ADMIK_MODULES = modules;
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  delete process.env.CDEK_ACCOUNT; // mock-режим СДЭК
  delete process.env.CDEK_SECRET;
}

async function loadPvz() {
  vi.resetModules();
  return import('@/app/api/storefront/v1/delivery/cdek/pvz/route');
}
async function loadCalc() {
  vi.resetModules();
  return import('@/app/api/storefront/v1/delivery/cdek/calculate/route');
}

function authedGet(url: string) {
  return new Request(url, { headers: { 'x-storefront-key': KEY } });
}
function authedPost(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'x-storefront-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('storefront/delivery/cdek — конвейер', () => {
  beforeEach(() => setEnv('catalog,orders,cdek'));
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL.modules;
    process.env.STOREFRONT_API_KEYS = ORIGINAL.keys;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL.origins;
    if (ORIGINAL.account === undefined) delete process.env.CDEK_ACCOUNT;
    else process.env.CDEK_ACCOUNT = ORIGINAL.account;
    if (ORIGINAL.secret === undefined) delete process.env.CDEK_SECRET;
    else process.env.CDEK_SECRET = ORIGINAL.secret;
    if (ORIGINAL.from === undefined) delete process.env.CDEK_FROM_LOCATION_CODE;
    else process.env.CDEK_FROM_LOCATION_CODE = ORIGINAL.from;
    vi.resetModules();
  });

  // --- module gate -----------------------------------------------------------

  it('cdek выключен → 404 на /pvz', async () => {
    setEnv('catalog,orders');
    const { GET } = await loadPvz();
    const res = await GET(authedGet('http://x/?city_code=44'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('module_disabled');
  });

  it('cdek выключен → 404 на /calculate', async () => {
    setEnv('catalog,orders');
    const { POST } = await loadCalc();
    const res = await POST(
      authedPost('http://x/', { to: { city_code: 44 }, deliveryMode: 'pvz', items: [{ qty: 1 }] }),
    );
    expect(res.status).toBe(404);
  });

  // --- auth ------------------------------------------------------------------

  it('без ключа → 401 на /pvz', async () => {
    const { GET } = await loadPvz();
    const res = await GET(new Request('http://x/?city_code=44'));
    expect(res.status).toBe(401);
  });

  // --- pvz --------------------------------------------------------------------

  it('GET /pvz → фикстуры в DTO (без внутренних полей)', async () => {
    const { GET } = await loadPvz();
    const res = await GET(authedGet('http://x/?city_code=44'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const first = body.data[0]!;
    expect(typeof first.code).toBe('string');
    expect(typeof first.name).toBe('string');
    expect(first).toHaveProperty('address');
    expect(first).toHaveProperty('location');
    // CORS присутствует
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });

  it('GET /pvz без city_code/postal_code → 400 bad_request', async () => {
    const { GET } = await loadPvz();
    const res = await GET(authedGet('http://x/'));
    expect(res.status).toBe(400);
  });

  // --- calculate --------------------------------------------------------------

  it('POST /calculate → детерминированный mock-расчёт', async () => {
    const { POST } = await loadCalc();
    const make = () =>
      POST(
        authedPost('http://x/', {
          to: { city_code: 44 },
          deliveryMode: 'pvz',
          items: [{ qty: 1, weightG: 500 }],
        }),
      );
    const a = (await (await make()).json()) as { data: { cost: string; tariffCode: number; etaDays: unknown } };
    const b = (await (await make()).json()) as { data: { cost: string } };
    expect(Number(a.data.cost)).toBeGreaterThan(0);
    expect(a.data.cost).toBe(b.data.cost);
    expect(typeof a.data.tariffCode).toBe('number');
  });

  it('POST /calculate anti-tamper: from в теле игнорируется', async () => {
    const { POST } = await loadCalc();
    const withFrom = await POST(
      authedPost('http://x/', {
        to: { city_code: 44 },
        from: { city_code: 99999 }, // вредонос: должно игнорироваться
        from_location: { code: 1 },
        deliveryMode: 'pvz',
        items: [{ qty: 1, weightG: 500 }],
      }),
    );
    const withoutFrom = await POST(
      authedPost('http://x/', {
        to: { city_code: 44 },
        deliveryMode: 'pvz',
        items: [{ qty: 1, weightG: 500 }],
      }),
    );
    expect(withFrom.status).toBe(200);
    const a = (await withFrom.json()) as { data: { cost: string } };
    const b = (await withoutFrom.json()) as { data: { cost: string } };
    // from из тела не повлиял на расчёт → стоимость идентична.
    expect(a.data.cost).toBe(b.data.cost);
  });

  it('POST /calculate невалидное тело → 400', async () => {
    const { POST } = await loadCalc();
    const res = await POST(authedPost('http://x/', { deliveryMode: 'pvz' }));
    expect(res.status).toBe(400);
  });
});
