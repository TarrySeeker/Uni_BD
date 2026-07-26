import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 SECURITY — утечка ПЕРСОНАЛЬНЫХ ДАННЫХ по слабому пути доступа.
 *
 * БАГ (внесён починкой «покупатель не видит, куда едет посылка»): в публичный DTO
 * заказа добавили `delivery.address` (ДОМАШНИЙ АДРЕС покупателя) и
 * `delivery.pvzCode` (куда он придёт за посылкой), а GET /orders/:number отдаёт
 * заказ ещё и по ?email= — слабому подтверждению: номера заказов последовательны
 * (ПРЕФИКС-ГОД-NNNNNN), а email покупателя часто известен. Итог: перебором
 * номеров с известным email вытягивается физический адрес человека.
 *
 * ФИКС (тот же подход, что у кодов подарочных сертификатов — `{ allowEmail: false }`):
 * чувствительные поля отдаются ТОЛЬКО при СИЛЬНОМ подтверждении — HMAC-токен
 * заказа. По email покупатель по-прежнему видит свой трекинг (статус, трек, город,
 * суммы, позиции) — сценарий не сломан, но набор полей ровно тот, что был ДО правки.
 */

import {
  orderAccessToken,
  toOrderPublicDto,
  SENSITIVE_DELIVERY_FIELDS,
} from '@/lib/storefront/order-dto';
import type { Order, OrderItem } from '@/lib/orders/types';

const TEST_ENV = { APP_PASSWORD: 'test-secret' } as Record<string, string | undefined>;

const ORDER_ID = 'd81f1540-1800-49de-a5c1-c08368787686';
const NUMBER = 'CR-2026-000123';
const EMAIL = 'ivan@example.com';
const ADDRESS = 'ул. Тверская, 1, кв. 5';
const PVZ = 'MSK42';

/** Заказ, у которого заполнены ВСЕ поля доставки (иначе guard ничего не поймает). */
function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: NUMBER,
    status: 'paid',
    itemsTotal: '3000.00',
    discountTotal: '0.00',
    deliveryTotal: '350.00',
    grandTotal: '3350.00',
    currency: 'RUB',
    paymentMethod: 'card',
    paymentStatus: 'paid',
    paidAt: new Date('2026-06-15T11:00:00.000Z'),
    paymentRef: 'secret-pay-ref',
    paymentProvider: 'tbank',
    deliveryType: 'pvz',
    isPostamat: true,
    deliveryStatus: 'in_transit',
    deliveryCity: 'Москва',
    deliveryAddress: ADDRESS,
    deliveryPvzCode: PVZ,
    deliveryZoneId: 'msk',
    deliveryZoneLabel: 'Москва в пределах МКАД',
    deliveryCost: '350.00',
    cdekUuid: 'secret-cdek-uuid',
    cdekTrack: '1106109745',
    promoCodeId: null,
    promoCode: null,
    giftCertificateId: null,
    giftDiscountTotal: '0.00',
    customerId: null,
    customerName: 'Иван Петров',
    customerEmail: EMAIL,
    customerPhone: '+79991234567',
    comment: '',
    idempotencyKey: 'idem-key-secret',
    source: 'storefront',
    ip: '203.0.113.7',
    createdAt: new Date('2026-06-15T10:00:00.000Z'),
    updatedAt: new Date('2026-06-17T10:00:00.000Z'),
    ...over,
  } as Order;
}

const ITEMS: OrderItem[] = [];

// ---------------------------------------------------------------------------
// 1) DTO — чувствительные поля только при сильном подтверждении.
// ---------------------------------------------------------------------------

describe('toOrderPublicDto — чувствительные поля доставки', () => {
  it('🔴 ПО УМОЛЧАНИЮ (fail-closed) адрес и пункт выдачи НЕ отдаются', () => {
    const dto = toOrderPublicDto(makeOrder(), ITEMS);
    expect(dto.delivery.address).toBeNull();
    expect(dto.delivery.pvzCode).toBeNull();
    expect(JSON.stringify(dto)).not.toContain(ADDRESS);
  });

  it('при сильном подтверждении (токен) адрес и пункт выдачи отдаются', () => {
    const dto = toOrderPublicDto(makeOrder(), ITEMS, { includeSensitiveDelivery: true });
    expect(dto.delivery.address).toBe(ADDRESS);
    expect(dto.delivery.pvzCode).toBe(PVZ);
  });

  it('форма ответа НЕ меняется — ключи те же, скрытое = null (контракт витрины)', () => {
    const weak = toOrderPublicDto(makeOrder(), ITEMS);
    const strong = toOrderPublicDto(makeOrder(), ITEMS, { includeSensitiveDelivery: true });
    expect(Object.keys(weak.delivery).sort()).toEqual(Object.keys(strong.delivery).sort());
  });

  it('слабая ветка сохраняет весь ДО-правочный трекинг (сценарий по email жив)', () => {
    const d = toOrderPublicDto(makeOrder(), ITEMS).delivery;
    expect(d).toMatchObject({
      type: 'pvz',
      isPostamat: true,
      city: 'Москва',
      zoneId: 'msk',
      zoneLabel: 'Москва в пределах МКАД',
      track: '1106109745',
    });
  });

  it('🔴 GUARD: в слабой ветке НЕ появляется ни одно поле сверх разрешённого списка', () => {
    // Заказ заполнен целиком, поэтому любое НОВОЕ поле delivery окажется непустым
    // и уронит этот тест — автор обязан осознанно решить, чувствительное оно или нет.
    const weak = toOrderPublicDto(makeOrder(), ITEMS);
    const exposed = Object.entries(weak.delivery)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k]) => k)
      .sort();
    expect(exposed).toEqual(
      ['type', 'isPostamat', 'city', 'zoneId', 'zoneLabel', 'track'].sort(),
    );
  });

  it('GUARD: список чувствительных полей объявлен явно и покрыт скрытием', () => {
    expect([...SENSITIVE_DELIVERY_FIELDS].sort()).toEqual(['address', 'pvzCode']);
    const weak = toOrderPublicDto(makeOrder(), ITEMS).delivery as Record<string, unknown>;
    for (const field of SENSITIVE_DELIVERY_FIELDS) {
      expect(weak[field], field).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2) Роут GET /orders/:number — по email без адреса, по токену с адресом.
// ---------------------------------------------------------------------------

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';

const getOrderByNumber = vi.fn(async (n: string) =>
  n === NUMBER ? { order: makeOrder(), items: [] } : null,
);

async function get(query: string): Promise<{ status: number; body: string }> {
  vi.resetModules();
  vi.doMock('@/lib/orders/repository', () => ({ getOrderByNumber }));
  const { GET } = await import('@/app/api/storefront/v1/orders/[number]/route');
  const res = await GET(new Request(`http://x/?${query}`, { headers: { 'x-storefront-key': KEY } }), {
    params: Promise.resolve({ number: NUMBER }),
  });
  return { status: res.status, body: await res.text() };
}

describe('GET /orders/:number — адрес только по токену', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog,orders';
    process.env.STOREFRONT_API_KEYS = KEY;
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    process.env.APP_PASSWORD = TEST_ENV.APP_PASSWORD;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
  });

  it('🔴 доступ по EMAIL: заказ виден, домашний адрес — НЕТ', async () => {
    const r = await get(`email=${encodeURIComponent(EMAIL)}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('1106109745');
    expect(r.body).not.toContain(ADDRESS);
    expect(r.body).not.toContain(PVZ);
  });

  it('доступ по ТОКЕНУ: покупатель видит, куда едет посылка', async () => {
    const token = orderAccessToken(ORDER_ID, TEST_ENV);
    const r = await get(`token=${encodeURIComponent(token)}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(ADDRESS);
    expect(r.body).toContain(PVZ);
  });

  it('🔴 email + ЧУЖОЙ токен не повышает права до адреса', async () => {
    const r = await get(`email=${encodeURIComponent(EMAIL)}&token=${'x'.repeat(32)}`);
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(ADDRESS);
  });

  it('без подтверждения — по-прежнему 404 (анти-перебор не ослаблен)', async () => {
    const r = await get('');
    expect(r.status).toBe(404);
  });
});
