import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderAccessToken } from '@/lib/storefront/order-dto';

/**
 * Тесты POST /api/storefront/v1/payments/alfabank/init (зеркало paykeeper/init +
 * tbank/init). ANTI-ENUMERATION (единый 404), anti-tamper (сумма из тела игнор —
 * считает сервер), 409 при уже оплаченном/возвращённом заказе.
 *
 * Изоляция: getOrderByNumber и PaymentService замоканы (без БД/сети).
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
  delete process.env.ALFABANK_USERNAME;
  delete process.env.ALFABANK_PASSWORD;
}

function fakeOrder(over: Record<string, unknown> = {}) {
  return {
    id: EXISTING_ID,
    number: EXISTING_NUMBER,
    status: 'new',
    grandTotal: '1500.00',
    currency: 'RUB',
    paymentStatus: 'pending',
    deliveryType: 'pvz',
    deliveryStatus: 'pending',
    customerEmail: CUSTOMER_EMAIL,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

const initPayment = vi.fn(async () => ({
  paymentId: 'mock-alfa-1',
  paymentUrl: 'http://x/mock/alfabank/pay?orderNumber=ADMIK-2026-000042&orderId=mock-alfa-1&amount=150000',
  status: 'registered',
  isMock: true,
}));

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/orders/repository', () => ({
    getOrderByNumber: vi.fn(async (n: string) =>
      n === EXISTING_NUMBER ? { order: fakeOrder(), items: [] } : null,
    ),
  }));
  vi.doMock('@/lib/payments/alfabank/service', () => ({
    PaymentService: class {
      initPayment = initPayment;
    },
  }));
  return import('@/app/api/storefront/v1/payments/alfabank/init/route');
}

function authedPost(body: unknown) {
  return new Request('http://x/', {
    method: 'POST',
    headers: { 'x-storefront-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function init(body: unknown): Promise<{ status: number; code?: string; data?: unknown }> {
  const { POST } = await loadRoute();
  const res = await POST(authedPost(body));
  const json = (await res.json()) as { error?: { code?: string }; data?: unknown };
  return { status: res.status, code: json.error?.code, data: json.data };
}

describe('storefront/payments/alfabank/init', () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
    vi.doUnmock('@/lib/payments/alfabank/service');
    initPayment.mockClear();
  });

  it('несуществующий номер → 404 not_found', async () => {
    const r = await init({ orderNumber: MISSING_NUMBER });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
  });

  it('SECURITY: существующий без доступа → ТОТ ЖЕ 404 (не 403), init НЕ вызван', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
    expect(initPayment).not.toHaveBeenCalled();
  });

  it('верный токен → 200, paymentId + isMock (anti-tamper: сумма из тела игнор)', async () => {
    const token = orderAccessToken(EXISTING_ID, { APP_PASSWORD: 'token-secret-for-test' });
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token, amount: '1' });
    expect(r.status).toBe(200);
    expect(initPayment).toHaveBeenCalledTimes(1);
    expect((r.data as { paymentId: string }).paymentId).toBe('mock-alfa-1');
    // Сумма из тела в initPayment НЕ прокидывается (аргументы — order+items+opts).
    const [order] = initPayment.mock.calls[0] as unknown as [{ grandTotal: string }];
    expect(order.grandTotal).toBe('1500.00');
  });

  it('верный email → 200', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER, email: CUSTOMER_EMAIL });
    expect(r.status).toBe(200);
  });
});

describe('storefront/payments/alfabank/init — 409 уже оплачен', () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
    vi.doUnmock('@/lib/payments/alfabank/service');
    initPayment.mockClear();
  });

  async function loadPaidRoute() {
    vi.resetModules();
    vi.doMock('@/lib/orders/repository', () => ({
      getOrderByNumber: vi.fn(async () => ({
        order: fakeOrder({ paymentStatus: 'paid' }),
        items: [],
      })),
    }));
    vi.doMock('@/lib/payments/alfabank/service', () => ({
      PaymentService: class {
        initPayment = initPayment;
      },
    }));
    return import('@/app/api/storefront/v1/payments/alfabank/init/route');
  }

  it('уже оплаченный заказ (с доступом) → 409 conflict, init НЕ вызван', async () => {
    const { POST } = await loadPaidRoute();
    const res = await POST(authedPost({ orderNumber: EXISTING_NUMBER, email: CUSTOMER_EMAIL }));
    const json = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(409);
    expect(json.error?.code).toBe('conflict');
    expect(initPayment).not.toHaveBeenCalled();
  });
});
