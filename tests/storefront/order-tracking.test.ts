import { describe, it, expect } from 'vitest';

/**
 * Находка аудита №5: «покупатель не может узнать, где его посылка».
 *
 * Данные для ответа на этот вопрос уже были в публичном DTO заказа (статус
 * доставки + трек), но витрина их не рендерила, а вернуться к заказу позже было
 * некуда — страницы заказа не существовало.
 *
 * Здесь — СЕРВЕРНАЯ половина:
 *   • DTO отдаёт ВСЁ, что нужно для ответа «где посылка»: код и подпись статуса
 *     доставки, трек, способ, город, пункт выдачи/адрес — АДДИТИВНО (старые поля
 *     не тронуты, их рендерят другие тенанты);
 *   • периметр доступа к странице заказа — номер + токен (как у кодов
 *     сертификата): без токена/с чужим токеном заказ не открывается.
 */

import {
  orderAccessToken,
  verifyOrderAccess,
  toOrderPublicDto,
} from '@/lib/storefront/order-dto';
import { DELIVERY_STATUSES } from '@/lib/orders/types';
import { DELIVERY_STATUS_LABEL } from '@/lib/orders/labels';
import type { Order, OrderItem } from '@/lib/orders/types';

const TEST_ENV = { APP_PASSWORD: 'test-secret' } as Record<string, string | undefined>;

const ORDER_ID = 'd81f1540-1800-49de-a5c1-c08368787686';
const OTHER_ORDER_ID = '6dbc9eb3-9c13-46ee-9214-baa583708261';

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'CR-2026-000123',
    status: 'paid',
    itemsTotal: '3000.00',
    discountTotal: '0.00',
    deliveryTotal: '350.00',
    grandTotal: '3350.00',
    currency: 'RUB',
    // Снимок валюты отображения (0059): заказ оформлен в базовой валюте → null.
    displayCurrency: null,
    displayRate: null,
    displayTotal: null,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    paidAt: new Date('2026-06-15T11:00:00.000Z'),
    paymentRef: 'secret-pay-ref',
    paymentInitiatedAt: null,
    paymentProvider: 'tbank',
    deliveryType: 'pvz',
    isPostamat: false,
    deliveryStatus: 'in_transit',
    deliveryCity: 'Москва',
    deliveryAddress: null,
    deliveryPvzCode: 'MSK42',
    deliveryZoneId: null,
    deliveryZoneLabel: null,
    deliveryCost: '350.00',
    cdekUuid: 'secret-cdek-uuid',
    cdekTrack: '1106109745',
    promoCodeId: null,
    promoCode: null,
    giftCertificateId: null,
    giftDiscountTotal: '0.00',
    customerId: null,
    customerName: 'Иван Петров',
    customerEmail: 'Ivan@Example.COM',
    customerPhone: '+79991234567',
    comment: '',
    idempotencyKey: 'idem-key-secret',
    source: 'storefront',
    ip: '203.0.113.7',
    createdAt: new Date('2026-06-15T10:00:00.000Z'),
    updatedAt: new Date('2026-06-17T10:00:00.000Z'),
    ...over,
  };
}

const ITEMS: OrderItem[] = [];

describe('OrderPublicDto — покупателю видно, ГДЕ его посылка', () => {
  it('отдаёт код статуса доставки и его подпись', () => {
    const dto = toOrderPublicDto(makeOrder(), ITEMS);
    expect(dto.deliveryStatus).toBe('in_transit');
    expect(dto.deliveryStatusLabel).toBe(DELIVERY_STATUS_LABEL.in_transit);
  });

  it('🔴 отдаёт трек-номер (главный ответ на вопрос «где посылка»)', () => {
    expect(toOrderPublicDto(makeOrder(), ITEMS).delivery.track).toBe('1106109745');
  });

  it('🔴 АДДИТИВНО: пункт выдачи и адрес доставки доступны витрине ПО ТОКЕНУ', () => {
    // Это ЧУВСТВИТЕЛЬНЫЕ поля: под слабым подтверждением (email) они скрыты —
    // см. tests/storefront/order-sensitive-delivery.test.ts. Витрина ходит по токену.
    const strong = { includeSensitiveDelivery: true };

    const pvz = toOrderPublicDto(makeOrder(), ITEMS, strong);
    expect(pvz.delivery.pvzCode).toBe('MSK42');
    expect(pvz.delivery.address).toBeNull();

    const courier = toOrderPublicDto(
      makeOrder({
        deliveryType: 'courier',
        deliveryPvzCode: null,
        deliveryAddress: 'ул. Тверская, 1, кв. 5',
      }),
      ITEMS,
      strong,
    );
    expect(courier.delivery.pvzCode).toBeNull();
    expect(courier.delivery.address).toBe('ул. Тверская, 1, кв. 5');
  });

  it('старые поля delivery на месте (контракт не сломан для других тенантов)', () => {
    const d = toOrderPublicDto(makeOrder(), ITEMS).delivery;
    expect(d).toMatchObject({
      type: 'pvz',
      isPostamat: false,
      city: 'Москва',
      zoneId: null,
      zoneLabel: null,
      track: '1106109745',
    });
  });

  it('внутренние поля по-прежнему НЕ утекают', () => {
    const flat = JSON.stringify(toOrderPublicDto(makeOrder(), ITEMS));
    for (const secret of ['secret-cdek-uuid', 'secret-pay-ref', 'idem-key-secret', '203.0.113.7', ORDER_ID]) {
      expect(flat, secret).not.toContain(secret);
    }
  });

  it('каждый код статуса доставки платформы имеет подпись (без сырого кода)', () => {
    for (const code of DELIVERY_STATUSES) {
      const dto = toOrderPublicDto(makeOrder({ deliveryStatus: code }), ITEMS);
      expect(dto.deliveryStatusLabel, code).not.toBe(code);
      expect(dto.deliveryStatusLabel.length, code).toBeGreaterThan(0);
    }
  });
});

describe('Страница заказа — периметр «номер + токен»', () => {
  const order = makeOrder();
  const token = orderAccessToken(order.id, TEST_ENV);

  it('верный токен открывает заказ', () => {
    expect(verifyOrderAccess(order, { token }, TEST_ENV, { allowEmail: false })).toBe(true);
  });

  it('🔴 без подтверждения — отказ (анти-перебор номеров)', () => {
    expect(verifyOrderAccess(order, {}, TEST_ENV, { allowEmail: false })).toBe(false);
    expect(verifyOrderAccess(order, { token: '' }, TEST_ENV, { allowEmail: false })).toBe(false);
    expect(verifyOrderAccess(order, { token: null }, TEST_ENV, { allowEmail: false })).toBe(false);
  });

  it('🔴 токен ЧУЖОГО заказа не открывает этот заказ', () => {
    const foreign = orderAccessToken(OTHER_ORDER_ID, TEST_ENV);
    expect(foreign).not.toBe(token);
    expect(verifyOrderAccess(order, { token: foreign }, TEST_ENV, { allowEmail: false })).toBe(false);
  });

  it('🔴 токен нельзя подделать без секрета магазина', () => {
    const otherSecret = orderAccessToken(order.id, { APP_PASSWORD: 'another-secret' });
    expect(otherSecret).not.toBe(token);
    expect(verifyOrderAccess(order, { token: otherSecret }, TEST_ENV, { allowEmail: false })).toBe(false);
  });

  it('токен детерминирован (ссылка работает и через неделю, в БД не хранится)', () => {
    expect(orderAccessToken(order.id, TEST_ENV)).toBe(token);
    expect(token).toHaveLength(32);
  });
});
