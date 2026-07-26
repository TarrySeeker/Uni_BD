import { describe, it, expect } from 'vitest';

/**
 * Трек T7 — публичная выдача кода подарочного сертификата покупателю.
 *
 * Код сертификата — ДЕНЬГИ НА ПРЕДЪЯВИТЕЛЯ, поэтому здесь проверяется не только
 * «правильно посчитали состояние», но и границы утечки:
 *  - общий DTO заказа (OrderPublicDto) кода не содержит и содержать не может;
 *  - код собирается ТОЛЬКО при оплаченном и не отменённом/возвращённом заказе;
 *  - погашенные при возврате коды (status='disabled') покупателю не отдаются;
 *  - verifyOrderAccess умеет запрещать email-путь (для денег годится только токен).
 */

import {
  toOrderPublicDto,
  verifyOrderAccess,
  orderAccessToken,
} from '@/lib/storefront/order-dto';
import {
  buildGiftCodesPayload,
  isOrderEligibleForGiftCodes,
  toGiftOrderCodeDto,
  giftCodesRateKey,
  GIFT_CODES_RATE_LIMIT,
} from '@/lib/storefront/gift-order-codes';
import type { Order, OrderItem } from '@/lib/orders/types';
import type { GiftCertificate } from '@/lib/gift-certificates/types';

const ORDER_ID = 'd81f1540-1800-49de-a5c1-c08368787686';
const ITEM_ID = 'f5eafff9-7402-4386-9d6f-ca1cc5701faf';
const TEST_ENV = { APP_PASSWORD: 'test-secret' } as Record<string, string | undefined>;

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'GA-2026-000123',
    status: 'new',
    itemsTotal: '3000.00',
    discountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '3000.00',
    currency: 'RUB',
    paymentMethod: 'card',
    paymentStatus: 'pending',
    paidAt: null,
    paymentRef: null,
    paymentInitiatedAt: null,
    paymentProvider: null,
    deliveryType: 'pvz',
    isPostamat: false,
    deliveryStatus: 'pending',
    deliveryCity: 'Москва',
    deliveryAddress: null,
    deliveryPvzCode: null,
    deliveryZoneId: null,
    deliveryZoneLabel: null,
    deliveryCost: '0.00',
    cdekUuid: null,
    cdekTrack: null,
    promoCodeId: null,
    promoCode: null,
    giftCertificateId: null,
    giftDiscountTotal: '0.00',
    customerId: null,
    customerName: 'Иван Петров',
    customerEmail: 'Ivan@Example.COM',
    customerPhone: '+79991234567',
    comment: '',
    idempotencyKey: null,
    source: 'storefront',
    ip: null,
    createdAt: new Date('2026-06-15T10:00:00.000Z'),
    updatedAt: new Date('2026-06-15T10:00:00.000Z'),
    ...over,
  };
}

function makeItem(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: ITEM_ID,
    orderId: ORDER_ID,
    productId: null,
    variantId: null,
    nameSnapshot: 'Подарочный сертификат 3000',
    skuSnapshot: 'GIFT-3000',
    attributesSnapshot: { gift_certificate: true },
    unitPrice: '3000.00',
    compareAtSnapshot: null,
    quantity: 1,
    lineTotal: '3000.00',
    isGift: false,
    weightG: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    createdAt: new Date('2026-06-15T10:00:00.000Z'),
    ...over,
  };
}

function makeCert(over: Partial<GiftCertificate> = {}): GiftCertificate {
  return {
    id: '6dbc9eb3-9c13-46ee-9214-baa583708261',
    code: 'SECRETCODE1234',
    name: 'Сертификат по заказу GA-2026-000123',
    description: null,
    terms: null,
    initialAmount: '3000.00',
    spentTotal: '0.00',
    remaining: '3000.00',
    currency: 'RUB',
    status: 'active',
    validUntil: null,
    translations: {},
    comment: '',
    purchaser: { name: 'Иван Петров', email: 'ivan@example.com', phone: null },
    purchaserCustomerId: null,
    recipient: { name: null, email: null, phone: null },
    issuedOrderId: ORDER_ID,
    issuedOrderItemId: ITEM_ID,
    issueSource: 'auto',
    createdAt: new Date('2026-06-15T10:05:00.000Z'),
    updatedAt: new Date('2026-06-15T10:05:00.000Z'),
    ...over,
  };
}

const PAID: Partial<Order> = { paymentStatus: 'paid', status: 'paid', paidAt: new Date() };
const SETTINGS = { autoIssue: true, validDays: null, categorySlugs: [], allowIssueOnGiftPaidOrder: false };

// -----------------------------------------------------------------------------
// 1) Общий DTO заказа НЕ содержит код (запрет расширения OrderPublicDto).
// -----------------------------------------------------------------------------

describe('OrderPublicDto — кода сертификата в общем DTO заказа нет', () => {
  it('ни на верхнем уровне, ни в позициях нет ключа code / значения кода', () => {
    const dto = toOrderPublicDto(makeOrder(PAID), [makeItem()]);
    expect(Object.keys(dto)).not.toContain('code');
    expect(Object.keys(dto)).not.toContain('giftCodes');
    for (const item of dto.items) {
      expect(Object.keys(item)).not.toContain('code');
    }
    expect(JSON.stringify(dto)).not.toContain('SECRETCODE1234');
  });
});

// -----------------------------------------------------------------------------
// 2) verifyOrderAccess — опция запрета email-пути.
// -----------------------------------------------------------------------------

describe('verifyOrderAccess — allowEmail', () => {
  const order = makeOrder();

  it('по умолчанию email-путь работает (существующие вызовы не сломаны)', () => {
    expect(verifyOrderAccess(order, { email: 'ivan@example.com' }, TEST_ENV)).toBe(true);
  });

  it('allowEmail:false — верный email больше НЕ даёт доступ', () => {
    expect(
      verifyOrderAccess(order, { email: 'ivan@example.com' }, TEST_ENV, { allowEmail: false }),
    ).toBe(false);
  });

  it('allowEmail:false — верный токен по-прежнему даёт доступ', () => {
    const token = orderAccessToken(order.id, TEST_ENV);
    expect(verifyOrderAccess(order, { token }, TEST_ENV, { allowEmail: false })).toBe(true);
  });

  it('allowEmail:false — чужой токен доступа не даёт', () => {
    expect(
      verifyOrderAccess(order, { token: 'x'.repeat(32) }, TEST_ENV, { allowEmail: false }),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 3) Состояние блока и состав выдачи.
// -----------------------------------------------------------------------------

describe('buildGiftCodesPayload — три состояния', () => {
  it('заказ без позиций-сертификатов → none, кодов нет', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [makeItem({ attributesSnapshot: {}, nameSnapshot: 'Платок' })],
      certificates: [],
      settings: SETTINGS,
    });
    expect(payload.state).toBe('none');
    expect(payload.codes).toEqual([]);
  });

  it('позиция-сертификат есть, оплата не подтверждена → pending БЕЗ кодов', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(),
      items: [makeItem()],
      certificates: [],
      settings: SETTINGS,
    });
    expect(payload.state).toBe('pending');
    expect(payload.codes).toEqual([]);
  });

  it('🔴 оплата не подтверждена, но сертификат в БД уже есть → код НЕ отдаём', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(),
      items: [makeItem()],
      certificates: [makeCert()],
      settings: SETTINGS,
    });
    expect(payload.codes).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('SECRETCODE1234');
  });

  it('оплачено и код выпущен → ready с номиналом/остатком/сроком', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [makeItem()],
      certificates: [makeCert({ validUntil: new Date('2027-06-15T10:00:00.000Z') })],
      settings: SETTINGS,
    });
    expect(payload.state).toBe('ready');
    expect(payload.codes).toEqual([
      {
        code: 'SECRETCODE1234',
        amount: '3000.00',
        remaining: '3000.00',
        currency: 'RUB',
        validUntil: '2027-06-15T10:00:00.000Z',
      },
    ]);
  });

  it('оплачено, позиция-сертификат есть, код ещё не доехал → pending (автовыпуск догоняет)', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [makeItem()],
      certificates: [],
      settings: SETTINGS,
    });
    expect(payload.state).toBe('pending');
  });

  it('🔴 заказ возвращён → ни кодов, ни обещания (none)', () => {
    for (const status of ['cancelled', 'refunded'] as const) {
      const payload = buildGiftCodesPayload({
        order: makeOrder({ ...PAID, status }),
        items: [makeItem()],
        certificates: [makeCert()],
        settings: SETTINGS,
      });
      expect(payload.state).toBe('none');
      expect(payload.codes).toEqual([]);
    }
  });

  it('🔴 погашенный при возврате код (status=disabled) покупателю не отдаётся', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [makeItem()],
      certificates: [makeCert({ status: 'disabled' })],
      settings: SETTINGS,
    });
    expect(payload.codes).toEqual([]);
    expect(payload.state).toBe('pending');
  });

  it('частично потраченный код показывает остаток', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [makeItem()],
      certificates: [makeCert({ spentTotal: '500.00', remaining: '2500.00' })],
      settings: SETTINGS,
    });
    expect(payload.codes[0]).toMatchObject({ amount: '3000.00', remaining: '2500.00' });
  });

  it('автовыпуск выключен и кодов нет → none (не обещаем того, чего не будет)', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [makeItem()],
      certificates: [],
      settings: { ...SETTINGS, autoIssue: false },
    });
    expect(payload.state).toBe('none');
  });

  it('автовыпуск выключен, но код выпущен вручную → ready (код показываем)', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [makeItem()],
      certificates: [makeCert()],
      settings: { ...SETTINGS, autoIssue: false },
    });
    expect(payload.state).toBe('ready');
    expect(payload.codes).toHaveLength(1);
  });

  it('«подарочная упаковка» в названии сертификатом не считается (нет маркера)', () => {
    const payload = buildGiftCodesPayload({
      order: makeOrder(PAID),
      items: [
        makeItem({ attributesSnapshot: {}, nameSnapshot: 'Подарочная упаковка (сертификат качества)' }),
      ],
      certificates: [],
      settings: SETTINGS,
    });
    expect(payload.state).toBe('none');
  });
});

describe('isOrderEligibleForGiftCodes', () => {
  it('только paid + не cancelled/refunded', () => {
    expect(isOrderEligibleForGiftCodes({ paymentStatus: 'paid', status: 'new' })).toBe(true);
    expect(isOrderEligibleForGiftCodes({ paymentStatus: 'pending', status: 'new' })).toBe(false);
    expect(isOrderEligibleForGiftCodes({ paymentStatus: 'failed', status: 'new' })).toBe(false);
    expect(isOrderEligibleForGiftCodes({ paymentStatus: 'paid', status: 'cancelled' })).toBe(false);
    expect(isOrderEligibleForGiftCodes({ paymentStatus: 'paid', status: 'refunded' })).toBe(false);
  });
});

describe('toGiftOrderCodeDto', () => {
  it('отдаёт только код/номинал/остаток/валюту/срок — без внутренних id и сторон сделки', () => {
    const dto = toGiftOrderCodeDto(makeCert());
    expect(Object.keys(dto).sort()).toEqual(
      ['amount', 'code', 'currency', 'remaining', 'validUntil'].sort(),
    );
    expect(JSON.stringify(dto)).not.toContain('ivan@example.com');
    expect(JSON.stringify(dto)).not.toContain(ORDER_ID);
  });
});

// -----------------------------------------------------------------------------
// 4) Собственный жёсткий rate-limit (общий 600/мин на IP для денег не годится).
// -----------------------------------------------------------------------------

describe('rate-limit выдачи кодов', () => {
  it('порог заметно жёстче общего storefront-лимита (600/мин)', () => {
    expect(GIFT_CODES_RATE_LIMIT.maxAttempts).toBeLessThanOrEqual(60);
    expect(GIFT_CODES_RATE_LIMIT.windowSec).toBeGreaterThanOrEqual(60);
  });

  it('ключ ведра отдельный (не пересекается с общим storefront-ведром) и по IP', () => {
    const key = giftCodesRateKey('203.0.113.7');
    expect(key).toContain('203.0.113.7');
    expect(key.startsWith('storefront:ip:')).toBe(false);
    expect(giftCodesRateKey(undefined)).not.toBe(key);
  });
});
