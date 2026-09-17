import { describe, it, expect } from 'vitest';

/**
 * Тесты двух фич доставки, вернувшихся в кит из боевого магазина
 * (боевой аудит СДЭК 2026-07-09):
 *
 * (A) delivery_city_code — числовой код города СДЭК на заказе. Проверяем, что
 *     код доезжает до to_location курьерской накладной, а при его отсутствии
 *     остаётся фоллбэк на строковое название города.
 * (B) CDEK_CREATE_ON_ORDER — регистрация накладной сразу при оформлении для
 *     магазина без онлайн-кассы. Проверяем ЧИСТОЕ решение
 *     wantsCdekShipmentOnOrder и снятие гейта оплаты в canCreateShipment.
 *
 * Всё чистое: без сети и БД.
 */

import {
  buildPayload,
  canCreateShipment,
  wantsCdekShipmentOnOrder,
  type BuildPayloadOptions,
} from '@/lib/cdek/services/order';
import { getCdekConfig } from '@/lib/cdek/config';
import type { Order, OrderItem } from '@/lib/orders/types';

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    number: 'TC-2026-000123',
    status: 'paid',
    itemsTotal: '1000.00',
    discountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '1000.00',
    currency: 'RUB',
    paymentMethod: 'card',
    paymentStatus: 'paid',
    paidAt: new Date(),
    paymentRef: null,
    paymentProvider: null,
    deliveryType: 'courier',
    deliveryStatus: 'pending',
    deliveryCity: 'Москва',
    deliveryCityCode: null,
    deliveryAddress: 'ул. Тверская, д. 1',
    deliveryPvzCode: null,
    deliveryCost: '0.00',
    cdekUuid: null,
    cdekTrack: null,
    promoCodeId: null,
    promoCode: null,
    customerId: null,
    customerName: 'Иван Иванов',
    customerEmail: 'ivan@example.com',
    customerPhone: '+7 (912) 345-67-89',
    comment: '',
    idempotencyKey: null,
    source: 'storefront',
    ip: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeItem(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'it-1',
    orderId: 'ord-1',
    productId: 'p-1',
    variantId: 'v-1',
    nameSnapshot: 'Чехол',
    skuSnapshot: 'SKU1',
    attributesSnapshot: {},
    unitPrice: '500.00',
    compareAtSnapshot: null,
    quantity: 2,
    lineTotal: '1000.00',
    isGift: false,
    weightG: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    createdAt: new Date(),
    ...over,
  };
}

const buildOpts: BuildPayloadOptions = {
  defaultDimensions: mockCfg.defaultDimensions,
  fromLocationCode: mockCfg.fromLocationCode,
  shipmentPoint: null,
  defaultTariffCode: mockCfg.defaultTariffCode,
  doorTariffCode: mockCfg.doorTariffCode,
  sender: {
    name: 'ООО Тест',
    contactName: 'Менеджер',
    phone: '+79000000000',
    email: 's@e.ru',
    inn: '7700000000',
  },
};

// -----------------------------------------------------------------------------
// (A) delivery_city_code → to_location
// -----------------------------------------------------------------------------

describe('cdek/order — код города СДЭК доезжает в to_location (фикс 4)', () => {
  it('курьер с deliveryCityCode → to_location.code = числовой код', () => {
    const order = makeOrder({ deliveryType: 'courier', deliveryCityCode: 44 });
    const payload = buildPayload(order, [makeItem()], buildOpts);
    expect(payload.to_location?.code).toBe(44);
    expect(payload.to_location?.address).toBe('ул. Тверская, д. 1');
  });

  it('код города НЕ задан → фоллбэк на строковое название (обратная совместимость)', () => {
    // Старые заказы оформлялись до появления колонки: у них кода нет, и накладная
    // обязана продолжать собираться по названию города, а не падать.
    const order = makeOrder({ deliveryType: 'courier', deliveryCityCode: null });
    const payload = buildPayload(order, [makeItem()], buildOpts);
    expect(payload.to_location?.code).toBeUndefined();
    expect(payload.to_location?.city).toBe('Москва');
  });

  it('код и название вместе → в payload уходят оба (code приоритетен для СДЭК)', () => {
    const order = makeOrder({
      deliveryType: 'courier',
      deliveryCityCode: 137,
      deliveryCity: 'Санкт-Петербург',
    });
    const payload = buildPayload(order, [makeItem()], buildOpts);
    expect(payload.to_location).toMatchObject({ code: 137, city: 'Санкт-Петербург' });
  });

  it('ПВЗ → to_location не собирается вовсе (адресат = код ПВЗ)', () => {
    const order = makeOrder({
      deliveryType: 'pvz',
      deliveryPvzCode: 'MSK1',
      deliveryCityCode: 44,
    });
    const payload = buildPayload(order, [makeItem()], buildOpts);
    expect(payload.delivery_point).toBe('MSK1');
    expect(payload.to_location).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// (B) CDEK_CREATE_ON_ORDER → wantsCdekShipmentOnOrder
// -----------------------------------------------------------------------------

describe('cdek/order — wantsCdekShipmentOnOrder (накладная при заказе)', () => {
  /** Все условия выполнены — базовый «да». */
  const allow = {
    reused: false,
    createOnOrder: true,
    deliveryType: 'courier',
    cdekModuleEnabled: true,
  };

  it('все условия выполнены → true', () => {
    expect(wantsCdekShipmentOnOrder(allow)).toBe(true);
  });

  it('🔴 самовывоз → false (накладной по самовывозу не существует)', () => {
    expect(wantsCdekShipmentOnOrder({ ...allow, deliveryType: 'pickup' })).toBe(false);
  });

  it('🔴 повторный (reused) заказ → false (не дёргаем СДЭК второй раз)', () => {
    // Ретрай витрины с тем же Idempotency-Key возвращает существующий заказ.
    // Второй вызов СДЭК здесь означал бы попытку дубля накладной.
    expect(wantsCdekShipmentOnOrder({ ...allow, reused: true })).toBe(false);
  });

  it('🔴 флаг выключен → false (дефолтное поведение магазина с кассой)', () => {
    expect(wantsCdekShipmentOnOrder({ ...allow, createOnOrder: false })).toBe(false);
  });

  it('🔴 модуль cdek выключен → false (единый рубильник, находка #6)', () => {
    // Раньше авто-создание обходило module toggle и ходило в СДЭК даже при
    // выключенном модуле.
    expect(wantsCdekShipmentOnOrder({ ...allow, cdekModuleEnabled: false })).toBe(false);
  });

  it('ПВЗ-доставка (не самовывоз) → true', () => {
    expect(wantsCdekShipmentOnOrder({ ...allow, deliveryType: 'pvz' })).toBe(true);
  });
});

describe('cdek/order — canCreateShipment с createOnOrder (гейт оплаты)', () => {
  const unpaid = makeOrder({ paymentStatus: 'pending', status: 'awaiting_payment' });

  it('неоплаченный + createOnOrder=true → можно (магазин без кассы)', () => {
    // Такой магазин не получит «paid» никогда: ждать оплату = не создать накладную.
    expect(canCreateShipment(unpaid, { createOnOrder: true }).ok).toBe(true);
  });

  it('🔴 неоплаченный + флаг выключен → нельзя (reason=not_paid)', () => {
    const res = canCreateShipment(unpaid, { createOnOrder: false });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_paid');
  });

  it('🔴 opts не переданы вовсе → прежнее поведение (гейт оплаты действует)', () => {
    // Совместимость со всеми существующими вызовами: отсутствие опции не должно
    // молча снимать защиту от отправки неоплаченного заказа.
    expect(canCreateShipment(unpaid).ok).toBe(false);
  });

  it('🔴 самовывоз + createOnOrder=true → всё равно нельзя (reason=pickup)', () => {
    // Флаг снимает ТОЛЬКО гейт оплаты, но не отменяет самовывоз.
    const res = canCreateShipment(
      makeOrder({ deliveryType: 'pickup' }),
      { createOnOrder: true },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('pickup');
  });
});

describe('cdek/config — CDEK_CREATE_ON_ORDER выключен по умолчанию', () => {
  it('🔴 env пуст → createOnOrder=false (магазин не меняет поведение молча)', () => {
    // Ключевое требование переноса: обновление кита не должно включить
    // регистрацию накладных до оплаты у магазинов, которым это не нужно.
    expect(getCdekConfig({ NODE_ENV: 'test' }).createOnOrder).toBe(false);
  });

  it('CDEK_CREATE_ON_ORDER=true → включается', () => {
    expect(
      getCdekConfig({ NODE_ENV: 'test', CDEK_CREATE_ON_ORDER: 'true' }).createOnOrder,
    ).toBe(true);
  });
});
