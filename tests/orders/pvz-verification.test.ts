import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ДЕФЕКТ (major): заказ принимался с НЕСУЩЕСТВУЮЩИМ кодом ПВЗ.
 *
 * pvzCode проходил только формальную валидацию «непустая строка ≤64»
 * (deliverySelectionSchema) и напрямую уезжал в orders.delivery_pvz_code, а
 * оттуда — в СДЭК как delivery_point. На боевых ключах такой заказ ОПЛАЧИВАЕТСЯ,
 * а накладную по нему не создать НИКОГДА (СДЭК отвергает неизвестный ПВЗ) —
 * тот же класс, что закрытый major №3/№18 «заказ, который невозможно отгрузить».
 *
 * Асимметрия, которую здесь устраняем: неизвестный zoneId отбивался ЖЁСТКО
 * (resolveDeliveryZoneStrict → invalid_zone), а неизвестный pvzCode — нет.
 *
 * Ключевое проектное решение проверяется тестами ниже: отличать ОТВЕТ службы
 * «такого ПВЗ нет» (жёсткий отказ) от НЕДОСТУПНОСТИ службы (fail-open, иначе
 * падение внешнего API блокирует ВСЕ заказы магазина).
 */

const ROOT = resolve(__dirname, '../..');
const src = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_ACCOUNT = process.env.CDEK_ACCOUNT;
const ORIGINAL_SECRET = process.env.CDEK_SECRET;

async function load() {
  vi.resetModules();
  return import('@/lib/orders/pvz-verification');
}

// =============================================================================
// (а) ЧИСТАЯ классификация: что делать с результатом проверки.
// =============================================================================
describe('classifyPvzVerification — чистое решение по результату проверки', () => {
  it('служба ответила «нашёлся» → ok', async () => {
    const { classifyPvzVerification } = await load();
    expect(classifyPvzVerification({ outcome: 'found' })).toBe('ok');
  });

  it('служба ответила «такого ПВЗ нет» → reject (жёсткий отказ)', async () => {
    const { classifyPvzVerification } = await load();
    expect(classifyPvzVerification({ outcome: 'not_found' })).toBe('reject');
  });

  it('служба НЕДОСТУПНА → ok (fail-open: сбой СДЭК не блокирует все заказы)', async () => {
    const { classifyPvzVerification } = await load();
    expect(classifyPvzVerification({ outcome: 'unavailable' })).toBe('ok');
  });

  it('проверка не применима (модуль выключен / не ПВЗ-доставка) → ok', async () => {
    const { classifyPvzVerification } = await load();
    expect(classifyPvzVerification({ outcome: 'skipped' })).toBe('ok');
  });
});

// =============================================================================
// (б) verifyPvzCode — сквозная проверка через СДЭК (mock-режим: фикстуры).
// =============================================================================
describe('verifyPvzCode — mock-режим СДЭК (пустые CDEK_*, фикстуры)', () => {
  beforeEach(() => {
    delete process.env.CDEK_ACCOUNT;
    delete process.env.CDEK_SECRET;
    process.env.ADMIK_MODULES = 'orders,cdek';
  });
  afterEach(() => {
    if (ORIGINAL_MODULES === undefined) delete process.env.ADMIK_MODULES;
    else process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    if (ORIGINAL_ACCOUNT === undefined) delete process.env.CDEK_ACCOUNT;
    else process.env.CDEK_ACCOUNT = ORIGINAL_ACCOUNT;
    if (ORIGINAL_SECRET === undefined) delete process.env.CDEK_SECRET;
    else process.env.CDEK_SECRET = ORIGINAL_SECRET;
    vi.resetModules();
  });

  it('код из фикстур (MSK1) → found', async () => {
    const { verifyPvzCode } = await load();
    expect((await verifyPvzCode({ deliveryType: 'pvz', pvzCode: 'MSK1' })).outcome).toBe('found');
  });

  it('🔴 несуществующий код → not_found (репро дефекта: раньше заказ создавался)', async () => {
    const { verifyPvzCode } = await load();
    const r = await verifyPvzCode({ deliveryType: 'pvz', pvzCode: 'NONEXISTENT-PVZ-999' });
    expect(r.outcome).toBe('not_found');
  });

  it('постамат из фикстур (MSK-POST1) → found (постамат — подвид ПВЗ)', async () => {
    const { verifyPvzCode } = await load();
    expect((await verifyPvzCode({ deliveryType: 'pvz', pvzCode: 'MSK-POST1' })).outcome).toBe(
      'found',
    );
  });

  it('курьер/самовывоз без pvzCode → skipped (проверять нечего)', async () => {
    const { verifyPvzCode } = await load();
    expect((await verifyPvzCode({ deliveryType: 'courier' })).outcome).toBe('skipped');
    expect((await verifyPvzCode({ deliveryType: 'pickup' })).outcome).toBe('skipped');
  });

  it('модуль cdek выключен → skipped (магазин возит сам, кодов ПВЗ не знает)', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { verifyPvzCode } = await load();
    expect((await verifyPvzCode({ deliveryType: 'pvz', pvzCode: 'NOPE' })).outcome).toBe('skipped');
  });
});

// =============================================================================
// (в) Устойчивость: сбой СДЭК ≠ «неверный код».
// =============================================================================
describe('verifyPvzCode — сбой службы СДЭК не выдаётся за неверный код', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    // Боевые ключи → real-путь, но сеть замокана на отказ (см. fetchImpl ниже).
    process.env.CDEK_ACCOUNT = 'acc-1';
    process.env.CDEK_SECRET = 'sec-1';
  });
  afterEach(() => {
    if (ORIGINAL_MODULES === undefined) delete process.env.ADMIK_MODULES;
    else process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    if (ORIGINAL_ACCOUNT === undefined) delete process.env.CDEK_ACCOUNT;
    else process.env.CDEK_ACCOUNT = ORIGINAL_ACCOUNT;
    if (ORIGINAL_SECRET === undefined) delete process.env.CDEK_SECRET;
    else process.env.CDEK_SECRET = ORIGINAL_SECRET;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('СДЭК недоступен (сеть упала) → unavailable, а НЕ not_found', async () => {
    // Сеть роняем на уровне global fetch: и токен, и /v2/deliverypoints идут им.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { verifyPvzCode } = await load();
    const r = await verifyPvzCode({ deliveryType: 'pvz', pvzCode: 'MSK77' });
    expect(r.outcome).toBe('unavailable');
    // И решение по нему — пропустить: временный сбой не блокирует все заказы.
    const { classifyPvzVerification } = await load();
    expect(classifyPvzVerification({ outcome: 'unavailable' })).toBe('ok');
  });
});

// =============================================================================
// (г) Guard-тесты по исходникам: проверка реально вплетена в создание заказа.
// =============================================================================
describe('guard: createOrder отбивает неизвестный ПВЗ так же строго, как зону', () => {
  const repo = src('lib/orders/repository.ts');

  it('repository зовёт проверку ПВЗ и отдаёт доменный код invalid_pvz', () => {
    expect(repo).toContain('verifyPvzCode');
    expect(repo).toContain("'invalid_pvz'");
  });

  it('решение принимается через классификатор (fail-open зашит в одном месте)', () => {
    expect(repo).toContain('classifyPvzVerification');
  });

  it('invalid_pvz входит в тип результата createOrder', () => {
    const type = repo.slice(
      repo.indexOf('export type CreateOrderResult'),
      repo.indexOf('export type CreateOrderResult') + 700,
    );
    expect(type).toContain('invalid_pvz');
  });
});

describe('guard: публичный алфавит причин витрины знает invalid_pvz', () => {
  it('серверный алфавит содержит причину (аддитивное расширение контракта)', () => {
    expect(src('lib/storefront/error-reasons.ts')).toContain("'invalid_pvz'");
  });

  it('витрина умеет перевести причину в строку словаря', () => {
    const ce = src('storefront/lib/checkout-errors.ts');
    expect(ce).toContain('invalid_pvz');
    expect(ce).toMatch(/invalid_pvz:\s*t\./);
  });
});

describe('guard: мультитенантность — никакого хардкода под конкретный магазин', () => {
  it('модуль проверки не содержит имён магазинов/доменов', () => {
    const mod = src('lib/orders/pvz-verification.ts');
    expect(mod).not.toMatch(/carre|erfgv|erfgq|uwerfvbhni/i);
  });
});
