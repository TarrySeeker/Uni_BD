import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderAccessToken } from '@/lib/storefront/order-dto';

/**
 * Тесты POST /api/storefront/v1/payments/init — ЕДИНОЙ инициации оплаты у
 * АКТИВНОГО эквайера (аудит major №1).
 *
 * ЧТО СТОРОЖИМ:
 *   • роут маршрутизирует по `PAYMENTS_PROVIDER`, а не в захардкоженный PayKeeper;
 *   • периметр защиты НЕ ослаблен относительно `paykeeper/init`: единый 404 для
 *     несуществующего И неавторизованного (анти-перебор номеров), 409 на уже
 *     оплаченном заказе, anti-tamper (сумма из тела игнорируется), module-gate
 *     `payments`, rate-limit/CORS конвейера runStorefront;
 *   • `manual` (офлайн-магазин) НЕ уводит покупателя на mock-страницу чужого
 *     эквайера, а честно отказывает.
 *
 * Изоляция: getOrderByNumber и все три PaymentService замоканы (без БД/сети).
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';

const EXISTING_ID = '11111111-1111-4111-8111-111111111111';
const EXISTING_NUMBER = 'ADMIK-2026-000042';
const MISSING_NUMBER = 'ADMIK-2026-999999';
const CUSTOMER_EMAIL = 'buyer@example.com';
const TOKEN_SECRET = 'token-secret-for-test';

function setEnv(provider?: string) {
  process.env.ADMIK_MODULES = 'catalog,orders,payments';
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  process.env.APP_PASSWORD = TOKEN_SECRET;
  if (provider) process.env.PAYMENTS_PROVIDER = provider;
  else delete process.env.PAYMENTS_PROVIDER;
  for (const k of [
    'PAYKEEPER_LOGIN',
    'PAYKEEPER_PASSWORD',
    'TBANK_TERMINAL_KEY',
    'TBANK_PASSWORD',
    'ALFABANK_USERNAME',
    'ALFABANK_PASSWORD',
  ]) {
    delete process.env[k];
  }
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

const tbankInit = vi.fn(async () => ({
  paymentId: 'tb-1',
  paymentUrl: 'http://x/mock/tbank/pay',
  status: 'NEW',
  isMock: true,
}));
const paykeeperInit = vi.fn(async () => ({
  invoiceId: 'pk-1',
  paymentUrl: 'http://x/mock/paykeeper/pay',
  status: 'pending',
  isMock: true,
}));
const alfabankInit = vi.fn(async () => ({
  paymentId: 'af-1',
  paymentUrl: 'http://x/mock/alfabank/pay',
  status: 'registered',
  isMock: true,
}));

async function loadRoute(order: Record<string, unknown> = fakeOrder()) {
  vi.resetModules();
  vi.doMock('@/lib/orders/repository', () => ({
    getOrderByNumber: vi.fn(async (n: string) => (n === EXISTING_NUMBER ? { order, items: [] } : null)),
  }));
  vi.doMock('@/lib/payments/tbank/service', () => ({
    PaymentService: class {
      initPayment = tbankInit;
    },
  }));
  vi.doMock('@/lib/payments/paykeeper/service', () => ({
    PaymentService: class {
      initPayment = paykeeperInit;
    },
  }));
  vi.doMock('@/lib/payments/alfabank/service', () => ({
    PaymentService: class {
      initPayment = alfabankInit;
    },
  }));
  return import('@/app/api/storefront/v1/payments/init/route');
}

function authedPost(body: unknown) {
  return new Request('http://x/', {
    method: 'POST',
    headers: { 'x-storefront-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function init(
  body: unknown,
  order?: Record<string, unknown>,
): Promise<{ status: number; code?: string; reason?: string; data?: Record<string, unknown> }> {
  const { POST } = await loadRoute(order);
  const res = await POST(authedPost(body));
  const json = (await res.json()) as {
    error?: { code?: string; reason?: string };
    data?: Record<string, unknown>;
  };
  return { status: res.status, code: json.error?.code, reason: json.error?.reason, data: json.data };
}

function token() {
  return orderAccessToken(EXISTING_ID, { APP_PASSWORD: TOKEN_SECRET });
}

function resetAll() {
  process.env = { ...ORIGINAL };
  vi.resetModules();
  vi.doUnmock('@/lib/orders/repository');
  vi.doUnmock('@/lib/payments/tbank/service');
  vi.doUnmock('@/lib/payments/paykeeper/service');
  vi.doUnmock('@/lib/payments/alfabank/service');
  tbankInit.mockClear();
  paykeeperInit.mockClear();
  alfabankInit.mockClear();
}

describe('POST /payments/init — оплата уходит АКТИВНОМУ эквайеру', () => {
  afterEach(resetAll);

  it('🔴 PAYMENTS_PROVIDER=tbank → tbank, PayKeeper НЕ вызван', async () => {
    setEnv('tbank');
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(200);
    expect(tbankInit).toHaveBeenCalledTimes(1);
    expect(paykeeperInit).not.toHaveBeenCalled();
    expect(r.data?.provider).toBe('tbank');
    expect(r.data?.paymentUrl).toBe('http://x/mock/tbank/pay');
  });

  it('🔴 дефолт (PAYMENTS_PROVIDER не задан) → тот же провайдер, что у getActivePaymentProvider', async () => {
    setEnv();
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(200);
    // Дефолт схемы env = tbank: витрина обязана прийти именно туда, а не в PayKeeper.
    expect(r.data?.provider).toBe('tbank');
    expect(paykeeperInit).not.toHaveBeenCalled();
  });

  it('PAYMENTS_PROVIDER=paykeeper → paykeeper, tbank НЕ вызван', async () => {
    setEnv('paykeeper');
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(200);
    expect(paykeeperInit).toHaveBeenCalledTimes(1);
    expect(tbankInit).not.toHaveBeenCalled();
    expect(r.data?.provider).toBe('paykeeper');
    // Обратная совместимость формы ответа: paymentId нормализован из invoiceId.
    expect(r.data?.paymentId).toBe('pk-1');
    expect(r.data?.invoiceId).toBe('pk-1');
  });

  it('PAYMENTS_PROVIDER=alfabank → alfabank', async () => {
    setEnv('alfabank');
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(200);
    expect(alfabankInit).toHaveBeenCalledTimes(1);
    expect(r.data?.provider).toBe('alfabank');
  });

  it('🔴 PAYMENTS_PROVIDER=manual → 422 payments_disabled, mock чужого шлюза недостижим', async () => {
    setEnv('manual');
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(422);
    expect(r.reason).toBe('payments_disabled');
    expect(tbankInit).not.toHaveBeenCalled();
    expect(paykeeperInit).not.toHaveBeenCalled();
    expect(alfabankInit).not.toHaveBeenCalled();
  });
});

describe('POST /payments/init — периметр защиты не ослаблен', () => {
  beforeEach(() => setEnv('tbank'));
  afterEach(resetAll);

  it('несуществующий номер → 404 not_found', async () => {
    const r = await init({ orderNumber: MISSING_NUMBER });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
  });

  it('🔴 SECURITY: существующий заказ без доступа → ТОТ ЖЕ 404 (не 403), init НЕ вызван', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
    expect(r.reason).toBe('order_not_found');
    expect(tbankInit).not.toHaveBeenCalled();
  });

  it('🔴 SECURITY: без ключа витрины (неавторизованный вызов) → init НЕ выполняется', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://x/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderNumber: EXISTING_NUMBER, accessToken: token() }),
      }),
    );
    expect(res.status).toBe(401);
    expect(tbankInit).not.toHaveBeenCalled();
  });

  it('🔴 SECURITY: модуль payments выключен → 404, init НЕ выполняется', async () => {
    process.env.ADMIK_MODULES = 'catalog,orders';
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(404);
    expect(tbankInit).not.toHaveBeenCalled();
  });

  it('верный email тоже даёт доступ (как в legacy-роутах)', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER, email: CUSTOMER_EMAIL });
    expect(r.status).toBe(200);
  });

  it('🔴 ANTI-TAMPER: сумма из тела в шлюз НЕ прокидывается', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token(), amount: '1' });
    expect(r.status).toBe(200);
    const [order] = tbankInit.mock.calls[0] as unknown as [{ grandTotal: string }];
    expect(order.grandTotal).toBe('1500.00');
  });

  it('невалидный JSON → 400 bad_request', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://x/', {
        method: 'POST',
        headers: { 'x-storefront-key': KEY, 'content-type': 'application/json' },
        body: '{нет',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('пустой orderNumber → 400 bad_request', async () => {
    const r = await init({ orderNumber: '' });
    expect(r.status).toBe(400);
    expect(r.code).toBe('bad_request');
  });

  it('🔴 уже оплаченный заказ → 409 conflict, init НЕ вызван', async () => {
    const r = await init(
      { orderNumber: EXISTING_NUMBER, email: CUSTOMER_EMAIL },
      fakeOrder({ paymentStatus: 'paid' }),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('conflict');
    expect(r.reason).toBe('order_not_payable');
    expect(tbankInit).not.toHaveBeenCalled();
  });

  it('🔴 холд (authorized) → 409 payment_in_progress, второй счёт НЕ выставляется', async () => {
    const r = await init(
      { orderNumber: EXISTING_NUMBER, email: CUSTOMER_EMAIL },
      fakeOrder({ paymentStatus: 'authorized' }),
    );
    expect(r.status).toBe(409);
    expect(r.reason).toBe('payment_in_progress');
    expect(tbankInit).not.toHaveBeenCalled();
  });

  it('OPTIONS отвечает preflight-ом (CORS конвейера)', async () => {
    const { OPTIONS } = await loadRoute();
    const res = await OPTIONS(new Request('http://x/', { method: 'OPTIONS' }));
    expect([200, 204]).toContain(res.status);
  });
});

describe('POST /payments/init — отказ шлюза не раскрывает внутренности', () => {
  afterEach(resetAll);

  it('исключение шлюза → 422 payment_init_failed', async () => {
    setEnv('tbank');
    tbankInit.mockRejectedValueOnce(new Error('gateway 500 secret-detail'));
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(422);
    expect(r.reason).toBe('payment_init_failed');
  });
});
