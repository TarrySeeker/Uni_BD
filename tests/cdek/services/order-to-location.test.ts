import { describe, it, expect, vi } from 'vitest';

/**
 * АУДИТ major #15: город получателя НЕ попадал в накладную СДЭК.
 *
 * Было: buildPayload для курьера (door) собирал `to_location` ТОЛЬКО из
 * order.deliveryAddress; поле order.deliveryCity игнорировалось, а code/postal_code
 * оставались пустыми. Для СДЭК это значит «город неизвестен» — накладная либо
 * отбивается валидацией, либо уезжает не в тот населённый пункт (одноимённые
 * улицы в разных городах).
 *
 * Числового кода города у заказа НЕТ (колонки delivery_city_code в схеме нет,
 * cityCode приходит на чекаут, но не сохраняется). Поэтому:
 *   • buildPayload остаётся ЧИСТОЙ и принимает УЖЕ РЕЗОЛВНУТЫЙ код опцией
 *     toCityCode (async-резолв делает вызывающий);
 *   • имя города (order.deliveryCity) кладётся в to_location.city ВСЕГДА —
 *     это то, что у заказа заведомо есть;
 *   • резолв имени → кода делает CityService.resolveCityCode (mock — фикстуры,
 *     real — GET /v2/location/cities), и его ПРОВАЛ НЕ БЛОКИРУЕТ накладную
 *     (деградация до city+address, как было бы у оператора вручную).
 */

import { buildPayload, type BuildPayloadOptions } from '@/lib/cdek/services/order';
import { CityService } from '@/lib/cdek/services/city';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';
import type { Order, OrderItem } from '@/lib/orders/types';

const buildOpts: BuildPayloadOptions = {
  defaultDimensions: { weightG: 500, lengthCm: 30, widthCm: 20, heightCm: 10 },
  fromLocationCode: 44,
  shipmentPoint: null,
  defaultTariffCode: 136,
  doorTariffCode: 137,
  sender: { name: null, contactName: null, phone: null, email: null, inn: null },
};

function makeOrder(patch: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    number: 'TC-2026-000123',
    customerName: 'Иван Иванов',
    customerPhone: '+7 912 345-67-89',
    customerEmail: 'i@example.com',
    deliveryType: 'courier',
    deliveryCity: 'Новосибирск',
    deliveryAddress: 'ул. Ленина, 1',
    deliveryPvzCode: null,
    paymentStatus: 'paid',
    status: 'paid',
    ...patch,
  } as unknown as Order;
}

function makeItem(): OrderItem {
  return {
    id: 'it-1',
    variantId: null,
    nameSnapshot: 'Платок',
    unitPrice: '1000.00',
    quantity: 1,
    weightG: 200,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
  } as unknown as OrderItem;
}

// ---------------------------------------------------------------------------
// buildPayload — город в to_location.
// ---------------------------------------------------------------------------

describe('#15 buildPayload — город получателя попадает в to_location', () => {
  it('курьер: имя города заказа (deliveryCity) уходит в to_location.city', () => {
    const p = buildPayload(makeOrder(), [makeItem()], buildOpts);
    expect(p.to_location?.city).toBe('Новосибирск');
    // Адрес по-прежнему на месте (регрессия прежнего поведения).
    expect(p.to_location?.address).toBe('ул. Ленина, 1');
  });

  it('курьер: переданный резолвнутый код города уходит в to_location.code', () => {
    const p = buildPayload(makeOrder(), [makeItem()], { ...buildOpts, toCityCode: 270 });
    expect(p.to_location?.code).toBe(270);
    expect(p.to_location?.city).toBe('Новосибирск');
  });

  it('код не резолвнулся (undefined) → накладная НЕ ломается, city+address на месте', () => {
    const p = buildPayload(makeOrder(), [makeItem()], { ...buildOpts, toCityCode: undefined });
    expect(p.to_location?.code).toBeUndefined();
    expect(p.to_location?.city).toBe('Новосибирск');
    expect(p.to_location?.address).toBe('ул. Ленина, 1');
  });

  it('город у заказа пуст → ключ city не выдумывается (пустая строка не уходит в СДЭК)', () => {
    const p = buildPayload(makeOrder({ deliveryCity: null }), [makeItem()], buildOpts);
    expect(p.to_location?.city).toBeUndefined();
    expect(p.to_location?.address).toBe('ул. Ленина, 1');
  });

  it('РЕГРЕССИЯ: ПВЗ-режим по-прежнему без to_location (адресация по delivery_point)', () => {
    const p = buildPayload(
      makeOrder({ deliveryType: 'pvz', deliveryPvzCode: 'MSK1' }),
      [makeItem()],
      { ...buildOpts, toCityCode: 44 },
    );
    expect(p.delivery_point).toBe('MSK1');
    expect(p.to_location).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CityService.resolveCityCode — резолв «название → код СДЭК».
// ---------------------------------------------------------------------------

function mockManager(): CdekManager {
  return new CdekManager({ config: getCdekConfig({ NODE_ENV: 'test' }) });
}

describe('#15 CityService.resolveCityCode — название города → код СДЭК', () => {
  it('mock-режим: точное совпадение по фикстурам (Новосибирск → 270)', async () => {
    const code = await new CityService(mockManager()).resolveCityCode('Новосибирск');
    expect(code).toBe(270);
  });

  it('регистр и пробелы не мешают (  моСКва  → 44)', async () => {
    const code = await new CityService(mockManager()).resolveCityCode('  моСКва  ');
    expect(code).toBe(44);
  });

  it('пустой/слишком короткий ввод → null (в СДЭК не ходим)', async () => {
    const svc = new CityService(mockManager());
    expect(await svc.resolveCityCode('')).toBeNull();
    expect(await svc.resolveCityCode('   ')).toBeNull();
    expect(await svc.resolveCityCode(null)).toBeNull();
  });

  it('ТОЧНОЕ имя выигрывает у подстроки: «Ростов-на-Дону» не отдаёт чужой код', async () => {
    const code = await new CityService(mockManager()).resolveCityCode('Ростов-на-Дону');
    expect(code).toBe(438);
  });

  it('real-режим: берётся ТОЧНОЕ совпадение имени, а не первый элемент ответа', async () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test', CDEK_ACCOUNT: 'a', CDEK_SECRET: 's' });
    const request = vi.fn(async () => [
      { code: 999, city: 'Новосибирская Слобода', region: 'X' },
      { code: 270, city: 'Новосибирск', region: 'Новосибирская область' },
    ]);
    const m = new CdekManager({ config: cfg });
    Object.defineProperty(m, 'client', { get: () => ({ request }) });

    const code = await new CityService(m).resolveCityCode('Новосибирск');
    expect(code).toBe(270);
  });

  it('real-режим: точного совпадения нет → null (не подставляем чужой город)', async () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test', CDEK_ACCOUNT: 'a', CDEK_SECRET: 's' });
    const request = vi.fn(async () => [{ code: 999, city: 'Совсем Другой', region: 'X' }]);
    const m = new CdekManager({ config: cfg });
    Object.defineProperty(m, 'client', { get: () => ({ request }) });

    expect(await new CityService(m).resolveCityCode('Новосибирск')).toBeNull();
  });

  it('real-режим: сбой СДЭК не бросает наружу → null (накладная не блокируется)', async () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test', CDEK_ACCOUNT: 'a', CDEK_SECRET: 's' });
    const request = vi.fn(async () => {
      throw new Error('cdek 500');
    });
    const m = new CdekManager({ config: cfg });
    Object.defineProperty(m, 'client', { get: () => ({ request }) });

    expect(await new CityService(m).resolveCityCode('Новосибирск')).toBeNull();
  });
});
