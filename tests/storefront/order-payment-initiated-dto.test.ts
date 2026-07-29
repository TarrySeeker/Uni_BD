import { describe, it, expect } from 'vitest';

import { toOrderPublicDto } from '@/lib/storefront/order-dto';
import type { Order, OrderItem } from '@/lib/orders/types';

/**
 * 🔴 ГОНКА «ОПЛАТИЛ → ВЕРНУЛСЯ РАНЬШЕ КОЛБЭКА»: серверный факт в публичном DTO.
 *
 * Витрина не имеет доступа ни к БД, ни к внутренним полям заказа. Отличить
 * «покупатель платит прямо сейчас, вебхук в пути» от «покупатель не платил» она
 * может ТОЛЬКО по факту, который отдаст сервер. Факт — время последней инициации
 * платежа (orders.payment_initiated_at, миграция 0058).
 *
 * Инварианты:
 *   • поле есть в DTO и приходит строкой ISO (null — не инициировался);
 *   • сам payment_ref (внутренний id счёта у эквайера) наружу по-прежнему НЕ
 *     уходит — отдаём производный факт, а не идентификатор платежа;
 *   • добавление АДДИТИВНО (контракт docs/21): прежние поля на месте.
 */

const ORDER_ID = '0d4f6c5a-3f4a-4a1f-9d90-1f2f6b7a2c11';

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'CR-2026-000777',
    status: 'new',
    itemsTotal: '1000.00',
    discountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '1000.00',
    currency: 'RUB',
    // Снимок валюты отображения (0059): заказ оформлен в базовой валюте → null.
    displayCurrency: null,
    displayRate: null,
    displayTotal: null,
    paymentMethod: 'card',
    paymentStatus: 'pending',
    paidAt: null,
    paymentRef: 'secret-invoice-id',
    paymentInitiatedAt: new Date('2026-07-26T11:59:00.000Z'),
    paymentProvider: 'paykeeper',
    deliveryType: 'pickup',
    isPostamat: false,
    deliveryStatus: 'pending',
    deliveryCity: null,
    deliveryAddress: null,
    deliveryPvzCode: null,
    deliveryZoneId: null,
    deliveryZoneLabel: null,
    deliveryCost: null,
    cdekUuid: null,
    cdekTrack: null,
    promoCodeId: null,
    promoCode: null,
    giftCertificateId: null,
    giftDiscountTotal: '0.00',
    customerId: null,
    customerName: 'Иван Петров',
    customerEmail: 'ivan@example.com',
    customerPhone: '+79991234567',
    comment: '',
    idempotencyKey: null,
    source: 'storefront',
    ip: null,
    createdAt: new Date('2026-07-26T11:58:00.000Z'),
    updatedAt: new Date('2026-07-26T11:59:00.000Z'),
    ...over,
  };
}

const ITEMS: OrderItem[] = [];

describe('OrderPublicDto — время инициации платежа', () => {
  it('🔴 отдаётся как ISO-строка: витрине есть от чего отсчитывать окно', () => {
    const dto = toOrderPublicDto(makeOrder(), ITEMS);
    expect(dto.paymentInitiatedAt).toBe('2026-07-26T11:59:00.000Z');
  });

  it('оплату не инициировали (или заказ старше миграции) → null', () => {
    const dto = toOrderPublicDto(makeOrder({ paymentInitiatedAt: null }), ITEMS);
    expect(dto.paymentInitiatedAt).toBeNull();
  });

  it('🔴 внутренний id счёта эквайера наружу не уходит', () => {
    const dto = toOrderPublicDto(makeOrder(), ITEMS) as unknown as Record<string, unknown>;
    expect(JSON.stringify(dto)).not.toContain('secret-invoice-id');
    expect(dto.paymentRef).toBeUndefined();
    expect(dto.paymentProvider).toBeUndefined();
  });

  it('расширение АДДИТИВНО: прежние поля контракта на месте', () => {
    const dto = toOrderPublicDto(makeOrder(), ITEMS);
    for (const key of ['number', 'status', 'paymentStatus', 'grandTotal', 'items', 'createdAt']) {
      expect(dto, key).toHaveProperty(key);
    }
  });
});
