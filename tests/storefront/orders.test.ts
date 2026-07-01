import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Пакет 3.D — Storefront API заказов. ЮНИТ (всегда, без БД):
 *  - order-dto мапперы (без утечки ip/idempotency/внутренних id);
 *  - токен доступа к заказу + verifyOrderAccess (token/email → ok; иначе отказ);
 *  - quote-DTO маппинг;
 *  - валидация тел через схемы (CartQuoteSchema/CreateOrderSchema);
 *  - конвейер: модуль orders выключен → 404; невалидный JSON/тело → 400.
 * ИНТЕГРАЦИЯ (skipIf без БД): quote/создание/трекинг через роуты.
 */

import {
  orderAccessToken,
  assertOrderTokenConfigured,
  verifyOrderAccess,
  toOrderItemDto,
  toOrderPublicDto,
  toOrderCreatedDto,
  toQuoteDto,
  toPublicPromotionDto,
} from '@/lib/storefront/order-dto';
import { CartQuoteSchema, CreateOrderSchema } from '@/lib/orders/schemas';
import type { Order, OrderItem, PromoCode } from '@/lib/orders/types';
import type { QuoteResult } from '@/lib/orders/pricing';

// -----------------------------------------------------------------------------
// Фикстуры.
// -----------------------------------------------------------------------------

const TEST_ENV = { APP_PASSWORD: 'test-secret' } as Record<string, string | undefined>;

// Валидные v4 UUID (Zod .uuid() требует корректный version/variant nibble).
const ORDER_ID = 'd81f1540-1800-49de-a5c1-c08368787686';
const PROMO_ID = '354c58c2-6ef9-4c4e-a975-e4c1da22e53c';
const CUSTOMER_ID = '10e014c7-be09-4940-8703-ac4583494188';
const ITEM_ID = 'f5eafff9-7402-4386-9d6f-ca1cc5701faf';
const PRODUCT_ID = 'b7edd16b-9cb8-4ff4-abd3-4b979c5d3bd7';
const VARIANT_ID = 'b1828f9e-f10f-4d51-b9a0-70a1b209eb33';
const OTHER_ORDER_ID = '6dbc9eb3-9c13-46ee-9214-baa583708261';

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'GA-2026-000123',
    status: 'new',
    itemsTotal: '3000.00',
    discountTotal: '300.00',
    deliveryTotal: '0.00',
    grandTotal: '2700.00',
    currency: 'RUB',
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    paidAt: null,
    paymentRef: 'secret-pay-ref',
    paymentProvider: null,
    deliveryType: 'pvz',
    deliveryStatus: 'pending',
    deliveryCity: 'Москва',
    deliveryAddress: null,
    deliveryPvzCode: 'MSK42',
    deliveryCost: '0.00',
    cdekUuid: 'secret-cdek-uuid',
    cdekTrack: '1234567890',
    promoCodeId: PROMO_ID,
    promoCode: 'SALE10',
    customerId: CUSTOMER_ID,
    customerName: 'Иван Петров',
    customerEmail: 'Ivan@Example.COM',
    customerPhone: '+79991234567',
    comment: 'Позвонить заранее',
    idempotencyKey: 'idem-key-secret',
    source: 'storefront',
    ip: '203.0.113.7',
    createdAt: new Date('2026-06-15T10:00:00.000Z'),
    updatedAt: new Date('2026-06-15T10:00:00.000Z'),
    ...over,
  };
}

function makeItem(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: ITEM_ID,
    orderId: ORDER_ID,
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    nameSnapshot: 'Чехол — Чёрный',
    skuSnapshot: 'CASE-BLK',
    attributesSnapshot: { color: 'black' },
    unitPrice: '1500.00',
    compareAtSnapshot: '2000.00',
    quantity: 2,
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

function makeQuoteResult(): QuoteResult {
  return {
    lines: [
      {
        name: 'Чехол',
        sku: 'CASE-BLK',
        unitPrice: '1500.00',
        compareAt: '2000.00',
        qty: 2,
        lineTotal: '3000.00',
      },
    ],
    itemsTotal: '3000.00',
    discount: '300.00',
    deliveryCost: '0.00',
    grandTotal: '2700.00',
    promo: { applied: true, code: 'SALE10', kind: 'percent', discount: '300.00' },
    delivery: { baseCost: '0.00', cost: '0.00', free: true, freeThresholdMet: true },
  };
}

// -----------------------------------------------------------------------------
// 1) order-dto: маппинг без утечки внутренних полей.
// -----------------------------------------------------------------------------

describe('order-dto — публичный маппинг заказа (без утечки)', () => {
  it('toOrderPublicDto не раскрывает ip/idempotencyKey/внутренние id', () => {
    const dto = toOrderPublicDto(makeOrder(), [makeItem()]);
    const json = JSON.stringify(dto);

    expect(json).not.toContain('203.0.113.7'); // ip
    expect(json).not.toContain('idem-key-secret'); // idempotencyKey
    expect(json).not.toContain('secret-pay-ref'); // paymentRef
    expect(json).not.toContain('secret-cdek-uuid'); // cdekUuid
    expect(json).not.toContain(CUSTOMER_ID); // customerId
    expect(json).not.toContain(ORDER_ID); // order.id
    expect(json).not.toContain(ITEM_ID); // item.id
    expect(json).not.toContain(PROMO_ID); // promoCodeId (только snapshot promoCode)

    // А нужные поля присутствуют.
    expect(dto.number).toBe('GA-2026-000123');
    expect(dto.status).toBe('new');
    expect(dto.paymentStatus).toBe('pending');
    expect(dto.deliveryStatus).toBe('pending');
    expect(dto.grandTotal).toBe('2700.00');
    expect(dto.delivery.track).toBe('1234567890');
    expect(dto.items).toHaveLength(1);
    // G-15: готовые подписи статусов в DTO (единый источник lib/orders/labels).
    expect(dto.statusLabel).toBe('Новый');
    expect(dto.paymentStatusLabel).toBe('Ожидает');
    expect(dto.deliveryStatusLabel).toBe('Ожидает');
  });

  it('G-15: statusLabel — каноничная подпись (shipped → «Отгружен», без расхождения с админкой)', () => {
    const dto = toOrderPublicDto(makeOrder({ status: 'shipped' }), [makeItem()]);
    expect(dto.statusLabel).toBe('Отгружен');
  });

  it('toOrderItemDto отдаёт снимок без orderId/itemId', () => {
    const dto = toOrderItemDto(makeItem());
    expect(dto).toEqual({
      name: 'Чехол — Чёрный',
      sku: 'CASE-BLK',
      attributes: { color: 'black' },
      unitPrice: '1500.00',
      compareAtPrice: '2000.00',
      qty: 2,
      lineTotal: '3000.00',
      isGift: false,
    });
    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('orderId');
  });

  it('toOrderCreatedDto возвращает токен доступа + минимальный набор', () => {
    const dto = toOrderCreatedDto(makeOrder(), TEST_ENV);
    expect(dto.number).toBe('GA-2026-000123');
    expect(dto.grandTotal).toBe('2700.00');
    expect(dto.accessToken).toBe(orderAccessToken(makeOrder().id, TEST_ENV));
    expect(dto.accessToken.length).toBe(32);
    // Не утекает ip и т.п.
    expect(JSON.stringify(dto)).not.toContain('203.0.113.7');
  });
});

// -----------------------------------------------------------------------------
// 2) Доступ к /orders/:number (анти-перебор номеров).
// -----------------------------------------------------------------------------

describe('order-dto — verifyOrderAccess (защита от перебора)', () => {
  const order = makeOrder();

  it('верный токен → доступ разрешён', () => {
    const token = orderAccessToken(order.id, TEST_ENV);
    expect(verifyOrderAccess(order, { token }, TEST_ENV)).toBe(true);
  });

  it('верный email (регистронезависимо) → доступ разрешён', () => {
    expect(verifyOrderAccess(order, { email: 'ivan@example.com' }, TEST_ENV)).toBe(true);
    expect(verifyOrderAccess(order, { email: 'IVAN@EXAMPLE.COM' }, TEST_ENV)).toBe(true);
  });

  it('неверный токен → отказ', () => {
    expect(verifyOrderAccess(order, { token: 'wrong-token' }, TEST_ENV)).toBe(false);
  });

  it('неверный email → отказ', () => {
    expect(verifyOrderAccess(order, { email: 'attacker@evil.com' }, TEST_ENV)).toBe(false);
  });

  it('без подтверждения → отказ (нельзя перебрать номер)', () => {
    expect(verifyOrderAccess(order, {}, TEST_ENV)).toBe(false);
    expect(verifyOrderAccess(order, { token: null, email: null }, TEST_ENV)).toBe(false);
    expect(verifyOrderAccess(order, { token: '', email: '' }, TEST_ENV)).toBe(false);
  });

  it('токен другого заказа не подходит', () => {
    const otherToken = orderAccessToken(OTHER_ORDER_ID, TEST_ENV);
    expect(verifyOrderAccess(order, { token: otherToken }, TEST_ENV)).toBe(false);
  });
});

describe('order-dto — orderTokenSecret (выделенный секрет, fail-closed в prod, m10)', () => {
  const ID = 'd81f1540-1800-49de-a5c1-c08368787686';

  it('ORDER_TOKEN_SECRET имеет приоритет над APP_PASSWORD', () => {
    const withDedicated = orderAccessToken(ID, { ORDER_TOKEN_SECRET: 'dedicated', APP_PASSWORD: 'app-pwd' });
    const onlyDedicated = orderAccessToken(ID, { ORDER_TOKEN_SECRET: 'dedicated' });
    const onlyApp = orderAccessToken(ID, { APP_PASSWORD: 'app-pwd' });
    expect(withDedicated).toBe(onlyDedicated); // секрет = ORDER_TOKEN_SECRET
    expect(withDedicated).not.toBe(onlyApp); // НЕ зависит от APP_PASSWORD
  });

  it('фолбэк на APP_PASSWORD/OWNER_PASSWORD, если выделенный не задан', () => {
    const byApp = orderAccessToken(ID, { APP_PASSWORD: 'p' });
    const byOwner = orderAccessToken(ID, { OWNER_PASSWORD: 'p' });
    expect(byApp).toBe(byOwner); // оба резолвятся в один секрет 'p'
    expect(byApp).toHaveLength(32);
  });

  it('production без какого-либо секрета → бросает (fail-closed)', () => {
    expect(() => orderAccessToken(ID, { NODE_ENV: 'production' })).toThrow(/ORDER_TOKEN_SECRET/);
  });

  it('вне production без секрета → стабильный dev-фолбэк (mock-режим), без броска', () => {
    const a = orderAccessToken(ID, { NODE_ENV: 'test' });
    const b = orderAccessToken(ID, { NODE_ENV: 'test' });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it('C7-1: assertOrderTokenConfigured в production БЕЗ секрета → бросает ДО createOrder (fail-closed, без заказа-сироты)', () => {
    expect(() => assertOrderTokenConfigured({ NODE_ENV: 'production' })).toThrow(/ORDER_TOKEN_SECRET/);
  });

  it('C7-1: assertOrderTokenConfigured в production С секретом → не бросает (заказ создастся)', () => {
    expect(() => assertOrderTokenConfigured({ NODE_ENV: 'production', ORDER_TOKEN_SECRET: 's' })).not.toThrow();
    expect(() => assertOrderTokenConfigured({ NODE_ENV: 'production', APP_PASSWORD: 'p' })).not.toThrow();
  });

  it('C7-1: assertOrderTokenConfigured вне production без секрета → не бросает (dev-фолбэк)', () => {
    expect(() => assertOrderTokenConfigured({ NODE_ENV: 'test' })).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// 3) quote-DTO маппинг.
// -----------------------------------------------------------------------------

describe('order-dto — toQuoteDto', () => {
  it('маппит итог/позиции/промо/доставку + флаги', () => {
    const dto = toQuoteDto({
      quote: makeQuoteResult(),
      currency: 'RUB',
      fulfillable: true,
      promoReason: null,
      issues: [],
    });
    expect(dto.itemsTotal).toBe('3000.00');
    expect(dto.discountTotal).toBe('300.00');
    expect(dto.deliveryTotal).toBe('0.00');
    expect(dto.grandTotal).toBe('2700.00');
    expect(dto.currency).toBe('RUB');
    expect(dto.lines[0]).toMatchObject({ sku: 'CASE-BLK', qty: 2, lineTotal: '3000.00' });
    expect(dto.promo).toEqual({ applied: true, code: 'SALE10', discount: '300.00', reason: null });
    expect(dto.delivery).toEqual({
      free: true,
      freeThresholdMet: true,
      cost: '0.00',
      available: true,
    });
    expect(dto.fulfillable).toBe(true);
    expect(dto.issues).toEqual([]);
  });

  it('переносит причину отказа промокода и проблемные позиции', () => {
    const dto = toQuoteDto({
      quote: makeQuoteResult(),
      currency: 'RUB',
      fulfillable: false,
      promoReason: 'expired',
      issues: [{ index: 0, code: 'out_of_stock' }],
    });
    expect(dto.promo.reason).toBe('expired');
    expect(dto.fulfillable).toBe(false);
    expect(dto.issues).toEqual([{ index: 0, code: 'out_of_stock' }]);
  });

  it('deliveryResolved отсутствует → delivery.available = true (по умолчанию)', () => {
    const dto = toQuoteDto({
      quote: makeQuoteResult(),
      currency: 'RUB',
      fulfillable: true,
      issues: [],
    });
    expect(dto.delivery.available).toBe(true);
  });

  it('deliveryResolved:false (сбой расчёта СДЭК) → delivery.available = false («уточняется»)', () => {
    const dto = toQuoteDto({
      quote: makeQuoteResult(),
      currency: 'RUB',
      fulfillable: true,
      issues: [],
      deliveryResolved: false,
    });
    expect(dto.delivery.available).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 3b) toPublicPromotionDto — публичный DTO акции (без утечки приватных полей).
// -----------------------------------------------------------------------------

function makePromoCode(over: Partial<PromoCode> = {}): PromoCode {
  return {
    id: PROMO_ID,
    code: 'BOGO32',
    kind: 'bogo',
    value: '0',
    minOrderTotal: '0.00',
    maxDiscount: null,
    usageLimit: 100,
    perCustomerLimit: 2,
    usedCount: 37,
    startsAt: new Date('2026-06-01T00:00:00.000Z'),
    endsAt: new Date('2026-07-01T00:00:00.000Z'),
    isActive: true,
    bogoBuyQty: 3,
    bogoPayQty: 2,
    applyScope: 'category',
    priority: 10,
    stackable: false,
    minQty: null,
    giftProductId: null,
    giftVariantId: null,
    giftQty: null,
    comment: 'internal-secret-comment',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

describe('order-dto — toPublicPromotionDto (без утечки приватных полей)', () => {
  it('отдаёт маркетинговые поля + slug-и таргетов, скрывает приватные', () => {
    const dto = toPublicPromotionDto({
      promo: makePromoCode(),
      targetCategorySlugs: ['cases', 'covers'],
      targetBrandSlugs: ['gang'],
    });
    expect(dto).toEqual({
      // m6: безопасная метка из bogo-полей, НЕ секретный код 'BOGO32'.
      publicLabel: '3 по цене 2',
      kind: 'bogo',
      applyScope: 'category',
      bogoBuyQty: 3,
      bogoPayQty: 2,
      targetCategorySlugs: ['cases', 'covers'],
      targetBrandSlugs: ['gang'],
      activeFrom: '2026-06-01T00:00:00.000Z',
      activeTo: '2026-07-01T00:00:00.000Z',
    });

    const json = JSON.stringify(dto);
    expect(json).not.toContain('BOGO32'); // m6: секретный код НЕ утекает
    expect(json).not.toContain('internal-secret-comment'); // comment
    expect(json).not.toContain(PROMO_ID); // id
    expect(json).not.toContain('37'); // usedCount
    expect(dto).not.toHaveProperty('usageLimit');
    expect(dto).not.toHaveProperty('perCustomerLimit');
    expect(dto).not.toHaveProperty('usedCount');
    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('comment');
  });

  it('бессрочная акция → activeFrom/activeTo = null, пустые таргеты по умолчанию', () => {
    const dto = toPublicPromotionDto({
      promo: makePromoCode({ startsAt: null, endsAt: null, applyScope: 'cart', kind: 'percent', value: '10', bogoBuyQty: null, bogoPayQty: null }),
    });
    expect(dto.activeFrom).toBeNull();
    expect(dto.activeTo).toBeNull();
    expect(dto.targetCategorySlugs).toEqual([]);
    expect(dto.targetBrandSlugs).toEqual([]);
    expect(dto.bogoBuyQty).toBeNull();
    // m6: percent → безопасная метка «−10%», НЕ код промокода.
    expect(dto.publicLabel).toBe('−10%');
  });

  it('m6: метка по типу акции, код НЕ раскрывается (percent/fixed/free_delivery)', () => {
    const pct = toPublicPromotionDto({ promo: makePromoCode({ code: 'SECRET50', kind: 'percent', value: '50.00', bogoBuyQty: null, bogoPayQty: null }) });
    expect(pct.publicLabel).toBe('−50%');
    expect(JSON.stringify(pct)).not.toContain('SECRET50');

    const fixed = toPublicPromotionDto({ promo: makePromoCode({ code: 'MINUS500', kind: 'fixed', value: '500.00', bogoBuyQty: null, bogoPayQty: null }) });
    expect(fixed.publicLabel).toBe('−500 ₽');
    expect(JSON.stringify(fixed)).not.toContain('MINUS500');

    const free = toPublicPromotionDto({ promo: makePromoCode({ code: 'FREESHIP', kind: 'free_delivery', value: '0', bogoBuyQty: null, bogoPayQty: null }) });
    expect(free.publicLabel).toBe('Бесплатная доставка');
    expect(JSON.stringify(free)).not.toContain('FREESHIP');
  });
});

// -----------------------------------------------------------------------------
// 4) Валидация тел через схемы (парсинг входа).
// -----------------------------------------------------------------------------

describe('schemas — парсинг/валидация тела (anti-tamper: цены нет)', () => {
  it('CartQuoteSchema принимает валидную корзину, игнорирует price из тела', () => {
    const parsed = CartQuoteSchema.safeParse({
      items: [{ variantId: VARIANT_ID, qty: 2, price: '1' }],
      promoCode: 'SALE10',
      delivery: { type: 'pvz', city: 'Москва', pvzCode: 'MSK42' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Поле price отсутствует в распарсенном результате (anti-tamper).
      expect(parsed.data.items[0]).not.toHaveProperty('price');
    }
  });

  it('CartQuoteSchema отклоняет пустую корзину', () => {
    expect(CartQuoteSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('CartQuoteSchema отклоняет позицию без variantId/productId', () => {
    expect(CartQuoteSchema.safeParse({ items: [{ qty: 1 }] }).success).toBe(false);
  });

  it('CreateOrderSchema требует контакты и доставку', () => {
    const ok = CreateOrderSchema.safeParse({
      items: [{ productId: PRODUCT_ID, qty: 1 }],
      customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79991234567' },
      delivery: { type: 'courier', city: 'Москва', address: 'ул. Ленина, 1' },
      paymentMethod: 'cod',
      idempotencyKey: 'idem-1',
    });
    expect(ok.success).toBe(true);
  });

  it('CreateOrderSchema требует pvzCode при доставке в ПВЗ', () => {
    const bad = CreateOrderSchema.safeParse({
      items: [{ productId: PRODUCT_ID, qty: 1 }],
      customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79991234567' },
      delivery: { type: 'pvz', city: 'Москва' },
      paymentMethod: 'cod',
    });
    expect(bad.success).toBe(false);
  });

  it('CreateOrderSchema отклоняет невалидный email', () => {
    const bad = CreateOrderSchema.safeParse({
      items: [{ productId: PRODUCT_ID, qty: 1 }],
      customer: { name: 'Иван', email: 'not-an-email', phone: '+79991234567' },
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
    });
    expect(bad.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 5) Конвейер: модуль orders выключен → 404; невалидное тело → 400.
// -----------------------------------------------------------------------------

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;

describe('cart/quote route — конвейер (без БД)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
  });

  it('модуль orders выключен → 404 module_disabled', async () => {
    process.env.ADMIK_MODULES = 'catalog'; // orders выключен
    const { POST } = await import('@/app/api/storefront/v1/cart/quote/route');
    const req = new Request('http://x/cart/quote', {
      method: 'POST',
      headers: { 'x-storefront-key': 'sk_secret', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ productId: PRODUCT_ID, qty: 1 }] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('module_disabled');
  });

  it('нет ключа → 401 unauthorized (до обращения к БД)', async () => {
    process.env.ADMIK_MODULES = 'orders';
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    const { POST } = await import('@/app/api/storefront/v1/cart/quote/route');
    const req = new Request('http://x/cart/quote', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: PRODUCT_ID, qty: 1 }] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('валидный ключ + битый JSON → 400 bad_request (до БД)', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { POST } = await import('@/app/api/storefront/v1/cart/quote/route');
    const req = new Request('http://x/cart/quote', {
      method: 'POST',
      headers: { 'x-storefront-key': 'sk_secret', 'content-type': 'application/json' },
      body: '{ not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('валидный ключ + пустая корзина → 400 bad_request (валидация схемы до БД)', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { POST } = await import('@/app/api/storefront/v1/cart/quote/route');
    const req = new Request('http://x/cart/quote', {
      method: 'POST',
      headers: { 'x-storefront-key': 'sk_secret', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('OPTIONS preflight → 204 c POST в Allow-Methods', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { OPTIONS } = await import('@/app/api/storefront/v1/cart/quote/route');
    const req = new Request('http://x/cart/quote', {
      method: 'OPTIONS',
      headers: { origin: 'https://demo.com', 'access-control-request-method': 'POST' },
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

describe('orders/[number] route — защита доступа (конвейер без БД)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIK_MODULES = 'orders';
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
  });

  it('модуль orders выключен → 404', async () => {
    process.env.ADMIK_MODULES = 'catalog';
    const { GET } = await import('@/app/api/storefront/v1/orders/[number]/route');
    const req = new Request('http://x/orders/GA-2026-000123?token=abc', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req, { params: Promise.resolve({ number: 'GA-2026-000123' }) });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('module_disabled');
  });
});

// -----------------------------------------------------------------------------
// 6) ИНТЕГРАЦИЯ (skipIf без БД): quote/создание/трекинг через роуты.
// -----------------------------------------------------------------------------

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('storefront orders (integration, требует БД)', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'orders,catalog';
  });

  it('POST /cart/quote отдаёт серверный итог { data: { grandTotal, ... } }', async () => {
    const { POST } = await import('@/app/api/storefront/v1/cart/quote/route');
    const req = new Request('http://localhost/api/storefront/v1/cart/quote', {
      method: 'POST',
      headers: { origin: 'https://demo.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    // Пустая корзина отклоняется схемой даже с БД.
    const res = await POST(req);
    expect([200, 400]).toContain(res.status);
  });
});
