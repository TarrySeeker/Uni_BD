import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderAccessToken } from '@/lib/storefront/order-dto';

/**
 * Тесты anti-enumeration для POST /api/storefront/v1/payments/tbank/init.
 *
 * БАГ (major, security — enumeration oracle): роут проверял существование заказа
 * ДО проверки доступа и отдавал РАЗНЫЕ статусы — 404 для несуществующего номера
 * и 403 для существующего без/с неверным токеном. Номера заказов предсказуемы
 * (ПРЕФИКС-ГОД-NNNNNN) → перебором по коду ответа (403=есть, 404=нет) клиент
 * витрины (только API-ключ) восстанавливает диапазон существующих заказов и их
 * общее число (утечка оборота).
 *
 * ФИКС (зеркалит GET /orders/:number): после getOrderByNumber вернуть ЕДИНЫЙ 404
 * not_found, когда (!found || !verifyOrderAccess(...)). Существование заказа НЕ
 * раскрывается до доказательства доступа.
 *
 * Изоляция: getOrderByNumber и PaymentService замоканы (без БД/сети). Доступ
 * подтверждается реальным orderAccessToken (как на витрине после POST /orders).
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';

const EXISTING_ID = '11111111-1111-4111-8111-111111111111';
const EXISTING_NUMBER = 'ADMIK-2026-000042';
const MISSING_NUMBER = 'ADMIK-2026-999999';
const CUSTOMER_EMAIL = 'buyer@example.com';

function setEnv() {
  process.env.ADMIK_MODULES = 'catalog,orders,payments';
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  process.env.APP_PASSWORD = 'token-secret-for-test';
  // mock-режим Т-Банка (PaymentService всё равно замокан, но на всякий случай).
  delete process.env.TBANK_TERMINAL_KEY;
  delete process.env.TBANK_PASSWORD;
}

/** Минимальный заказ, достаточный для веток доступа/конфликта/init. */
function fakeOrder(over: Record<string, unknown> = {}) {
  return {
    id: EXISTING_ID,
    number: EXISTING_NUMBER,
    status: 'new',
    grandTotal: '1500.00',
    currency: 'RUB',
    paymentMethod: 'online',
    paymentStatus: 'pending',
    deliveryType: 'cdek_pvz',
    deliveryStatus: 'pending',
    deliveryCity: null,
    cdekTrack: null,
    promoCode: null,
    customerEmail: CUSTOMER_EMAIL,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

const initPayment = vi.fn(async () => ({
  paymentId: 'mock-pay-1',
  paymentUrl: 'http://x/mock-pay',
  status: 'NEW',
  isMock: true,
}));

async function loadRoute() {
  vi.resetModules();
  // getOrderByNumber: возвращает заказ только для EXISTING_NUMBER, иначе null.
  vi.doMock('@/lib/orders/repository', () => ({
    getOrderByNumber: vi.fn(async (n: string) =>
      n === EXISTING_NUMBER ? { order: fakeOrder(), items: [] } : null,
    ),
  }));
  vi.doMock('@/lib/payments/tbank/service', () => ({
    PaymentService: class {
      initPayment = initPayment;
    },
  }));
  return import('@/app/api/storefront/v1/payments/tbank/init/route');
}

function authedPost(body: unknown) {
  return new Request('http://x/', {
    method: 'POST',
    headers: { 'x-storefront-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function init(body: unknown): Promise<{ status: number; code?: string }> {
  const { POST } = await loadRoute();
  const res = await POST(authedPost(body));
  if (res.status === 200) return { status: 200 };
  const json = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: json.error?.code };
}

describe('storefront/payments/tbank/init — anti-enumeration', () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
    vi.doUnmock('@/lib/payments/tbank/service');
    initPayment.mockClear();
  });

  it('несуществующий номер → 404 not_found (без раскрытия)', async () => {
    const r = await init({ orderNumber: MISSING_NUMBER });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
  });

  it('SECURITY: существующий БЕЗ токена → ТОТ ЖЕ 404 not_found (не 403)', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
    expect(initPayment).not.toHaveBeenCalled();
  });

  it('SECURITY: существующий с НЕВЕРНЫМ токеном → ТОТ ЖЕ 404 not_found (не 403)', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: 'wrong-token' });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
    expect(initPayment).not.toHaveBeenCalled();
  });

  it('SECURITY: 404 для несуществующего и для существующего-без-доступа НЕОТЛИЧИМЫ', async () => {
    const missing = await init({ orderNumber: MISSING_NUMBER });
    const existingNoAuth = await init({ orderNumber: EXISTING_NUMBER });
    expect(existingNoAuth.status).toBe(missing.status);
    expect(existingNoAuth.code).toBe(missing.code);
  });

  it('существующий с ВЕРНЫМ токеном → проходит к init (200)', async () => {
    const token = orderAccessToken(EXISTING_ID, {
      APP_PASSWORD: 'token-secret-for-test',
    });
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token });
    expect(r.status).toBe(200);
    expect(initPayment).toHaveBeenCalledTimes(1);
  });

  it('существующий с ВЕРНЫМ email → проходит к init (200)', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER, email: CUSTOMER_EMAIL });
    expect(r.status).toBe(200);
    expect(initPayment).toHaveBeenCalledTimes(1);
  });
});
