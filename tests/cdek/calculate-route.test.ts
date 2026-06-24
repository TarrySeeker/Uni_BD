import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Тесты enforcement allowedTariffs в storefront-расчёте СДЭК
 * (POST /api/storefront/v1/delivery/cdek/calculate, finding #4).
 *
 * СДЭК в mock-режиме (пустые CDEK_ACCOUNT/CDEK_SECRET): расчёт по формуле §5.3,
 * mockCalculateByTariff эхо-отдаёт переданный tariffCode → можно проверить, какой
 * тариф фактически ушёл в Calculator.
 *
 * Правило: если CDEK_ALLOWED_TARIFFS непуст и входной tariffCode НЕ в белом
 * списке — роут НЕ доверяет клиентскому коду, а подставляет defaultTariffCode
 * (CDEK_DEFAULT_TARIFF). Разрешённый код проходит как есть. Пустой allowedTariffs
 * = разрешены любые (обратная совместимость).
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';

function setEnv() {
  process.env.ADMIK_MODULES = 'catalog,orders,cdek';
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  delete process.env.CDEK_ACCOUNT; // mock-режим СДЭК
  delete process.env.CDEK_SECRET;
}

async function loadCalc() {
  vi.resetModules();
  return import('@/app/api/storefront/v1/delivery/cdek/calculate/route');
}

function authedPost(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'x-storefront-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function calc(body: unknown): Promise<{ status: number; data?: { tariffCode: number } }> {
  const { POST } = await loadCalc();
  const res = await POST(authedPost('http://x/', body));
  if (res.status !== 200) return { status: res.status };
  const json = (await res.json()) as { data: { tariffCode: number } };
  return { status: res.status, data: json.data };
}

describe('storefront/delivery/cdek/calculate — allowedTariffs enforcement', () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  const item = { to: { city_code: 44 }, deliveryMode: 'pvz', items: [{ qty: 1 }] } as const;

  it('allowedTariffs задан, входной tariffCode разрешён → используется он', async () => {
    process.env.CDEK_ALLOWED_TARIFFS = '136,138';
    process.env.CDEK_DEFAULT_TARIFF = '136';
    const r = await calc({ ...item, tariffCode: 138 });
    expect(r.status).toBe(200);
    expect(r.data?.tariffCode).toBe(138);
  });

  it('SECURITY: входной tariffCode НЕ в whitelist → fallback на defaultTariffCode', async () => {
    process.env.CDEK_ALLOWED_TARIFFS = '136,138';
    process.env.CDEK_DEFAULT_TARIFF = '136';
    const r = await calc({ ...item, tariffCode: 999 });
    expect(r.status).toBe(200);
    expect(r.data?.tariffCode).toBe(136); // подменён на дефолт, не 999
  });

  it('tariffCode не передан → используется defaultTariffCode (как раньше)', async () => {
    process.env.CDEK_ALLOWED_TARIFFS = '136,138';
    process.env.CDEK_DEFAULT_TARIFF = '136';
    const r = await calc({ ...item });
    expect(r.status).toBe(200);
    expect(r.data?.tariffCode).toBe(136);
  });

  it('allowedTariffs пуст → любой tariffCode проходит (обратная совместимость)', async () => {
    delete process.env.CDEK_ALLOWED_TARIFFS;
    process.env.CDEK_DEFAULT_TARIFF = '136';
    const r = await calc({ ...item, tariffCode: 999 });
    expect(r.status).toBe(200);
    expect(r.data?.tariffCode).toBe(999);
  });
});

/**
 * BUG #7 (reliability): не-UUID variantId/productId в items не должен ронять
 * расчёт в 500. До фикса схема позиции принимала z.string() без uuid-проверки →
 * мусорный id доходил до resolveCartLine → SELECT ... WHERE id = '${мусор}' с
 * ::uuid-кастом в БД → Postgres invalid_text_representation → 500.
 *
 * Семантика после фикса: items уже валидируются Zod (anti-tamper). Добавляем
 * uuid-валидацию variantId/productId в схему позиции → структурно невалидный id
 * = 400 bad_request на уровне схемы, НЕ доходит до ::uuid-каста. Best-effort
 * (skip) остаётся для валидных, но НЕсуществующих id (resolveCartLine → !ok).
 *
 * resolveCartLine мокаем, чтобы тест не требовал БД и чтобы НЕ-обращение к нему
 * на мусоре доказывало, что валидация отсекла ввод ДО запроса.
 */
describe('storefront/delivery/cdek/calculate — uuid-валидация позиций (BUG #7)', () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
  });

  it('variantId=garbage → НЕ 500 (400 bad_request, не доходит до resolveCartLine)', async () => {
    const resolveCartLine = vi.fn(async () => {
      throw new Error('resolveCartLine не должен вызываться на невалидном uuid');
    });
    vi.doMock('@/lib/orders/repository', () => ({ resolveCartLine }));

    const { POST } = await loadCalc();
    const res = await POST(
      authedPost('http://x/', {
        to: { city_code: 44 },
        items: [{ variantId: 'garbage', qty: 1 }],
      }),
    );
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('bad_request');
    expect(resolveCartLine).not.toHaveBeenCalled();
  });

  it('productId=garbage → НЕ 500 (400 bad_request)', async () => {
    const resolveCartLine = vi.fn(async () => {
      throw new Error('resolveCartLine не должен вызываться на невалидном uuid');
    });
    vi.doMock('@/lib/orders/repository', () => ({ resolveCartLine }));

    const { POST } = await loadCalc();
    const res = await POST(
      authedPost('http://x/', {
        to: { city_code: 44 },
        items: [{ productId: 'not-a-uuid', qty: 1 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(resolveCartLine).not.toHaveBeenCalled();
  });

  it('валидный, но НЕсуществующий uuid → best-effort skip (200, не 500)', async () => {
    // resolveCartLine отдаёт «не найдено» → позиция считается без габаритов.
    const resolveCartLine = vi.fn(async () => ({ ok: false, reason: 'variant_not_found' as const }));
    vi.doMock('@/lib/orders/repository', () => ({ resolveCartLine }));

    const { POST } = await loadCalc();
    const res = await POST(
      authedPost('http://x/', {
        to: { city_code: 44 },
        items: [{ variantId: '22222222-2222-4222-8222-222222222222', qty: 2 }],
      }),
    );
    expect(res.status).toBe(200);
    expect(resolveCartLine).toHaveBeenCalledTimes(1);
  });
});

/**
 * Волна 6 (DoS-амплификация): массив items без верхней границы запускал
 * Promise.all(resolveCartLine→getProductById = 6-7 SELECT) на каждый элемент.
 * Фикс: .max(MAX_CART_ITEMS=200) как в /cart/quote и /orders → лишние позиции
 * отсекаются схемой (400) ДО любых обращений к БД.
 */
describe('storefront/delivery/cdek/calculate — лимит числа позиций (волна 6, anti-DoS)', () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
  });

  it('> 200 позиций → 400 bad_request, resolveCartLine НЕ вызывается', async () => {
    const resolveCartLine = vi.fn(async () => {
      throw new Error('resolveCartLine не должен вызываться при превышении лимита позиций');
    });
    vi.doMock('@/lib/orders/repository', () => ({ resolveCartLine }));

    const { POST } = await loadCalc();
    const items = Array.from({ length: 201 }, () => ({ qty: 1 }));
    const res = await POST(authedPost('http://x/', { to: { city_code: 44 }, items }));
    expect(res.status).toBe(400);
    expect(resolveCartLine).not.toHaveBeenCalled();
  });

  it('ровно 200 позиций — в пределах лимита (схема не отвергает)', async () => {
    const resolveCartLine = vi.fn(async () => ({ ok: false, reason: 'variant_not_found' as const }));
    vi.doMock('@/lib/orders/repository', () => ({ resolveCartLine }));

    const { POST } = await loadCalc();
    const items = Array.from({ length: 200 }, () => ({ qty: 1 }));
    const res = await POST(authedPost('http://x/', { to: { city_code: 44 }, items }));
    expect(res.status).toBe(200);
  });
});
