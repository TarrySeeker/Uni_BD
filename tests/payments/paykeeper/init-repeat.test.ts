import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderAccessToken } from '@/lib/storefront/order-dto';

/**
 * ПОВТОРНАЯ инициация оплаты уже созданного заказа (аудит 2026-07-26, находка №1).
 *
 * Покупатель нажал «Отмена» на шлюзе / банк отказал / закрыл вкладку — заказ
 * остался в `pending`, корзина очищена. Единственный выход из тупика — оплатить
 * СУЩЕСТВУЮЩИЙ заказ по тому же периметру доступа (number + HMAC-token). Здесь
 * фиксируются гарантии этого пути:
 *   • pending → инициация разрешена и ПОВТОРЯЕМА (новый заказ не создаётся,
 *     эндпоинт вообще не умеет создавать заказы — только выставляет счёт);
 *   • paid/refunded → 409 order_not_payable (защита от двойной оплаты);
 *   • ОТМЕНЁННЫЙ заказ → 409 order_not_payable, а не «не удалось инициировать
 *     оплату»: причина покупателю понятна и переводима на витрине;
 *   • чужой/пустой токен → тот же 404, что и несуществующий номер, и шлюз не
 *     трогается вовсе (анти-перебор номеров).
 *
 * Изоляция: репозиторий заказов и PaymentService замоканы (без БД и сети).
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';
const SECRET = 'token-secret-for-test';

const EXISTING_ID = '11111111-1111-4111-8111-111111111111';
const EXISTING_NUMBER = 'ADMIK-2026-000042';
const CUSTOMER_EMAIL = 'buyer@example.com';

function setEnv() {
  process.env.ADMIK_MODULES = 'catalog,orders,payments';
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  process.env.APP_PASSWORD = SECRET;
  delete process.env.PAYKEEPER_LOGIN;
  delete process.env.PAYKEEPER_PASSWORD;
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

let invoiceSeq = 0;
const initPayment = vi.fn(async () => {
  invoiceSeq += 1;
  return {
    invoiceId: `mock-inv-${invoiceSeq}`,
    paymentUrl: `http://x/mock/paykeeper/pay?invoiceId=mock-inv-${invoiceSeq}`,
    status: 'sent',
    isMock: true,
  };
});

const createOrder = vi.fn();

async function loadRoute(order: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('@/lib/orders/repository', () => ({
    getOrderByNumber: vi.fn(async (n: string) =>
      n === EXISTING_NUMBER ? { order, items: [] } : null,
    ),
    createOrder,
  }));
  vi.doMock('@/lib/payments/paykeeper/service', () => ({
    PaymentService: class {
      initPayment = initPayment;
    },
  }));
  return import('@/app/api/storefront/v1/payments/paykeeper/init/route');
}

function authedPost(body: unknown) {
  return new Request('http://x/', {
    method: 'POST',
    headers: { 'x-storefront-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function init(
  order: Record<string, unknown>,
  body: unknown,
): Promise<{ status: number; code?: string; reason?: string; data?: unknown }> {
  const { POST } = await loadRoute(order);
  const res = await POST(authedPost(body));
  const json = (await res.json()) as {
    error?: { code?: string; reason?: string };
    data?: unknown;
  };
  return { status: res.status, code: json.error?.code, reason: json.error?.reason, data: json.data };
}

const token = (): string => orderAccessToken(EXISTING_ID, { APP_PASSWORD: SECRET });

describe('повторная оплата созданного заказа — POST /payments/paykeeper/init', () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
    vi.doUnmock('@/lib/payments/paykeeper/service');
    initPayment.mockClear();
    createOrder.mockClear();
    invoiceSeq = 0;
  });

  it('🔴 pending + верный токен → 200: покупатель выходит из тупика', async () => {
    const r = await init(fakeOrder(), { orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(200);
    expect((r.data as { paymentUrl: string }).paymentUrl).toContain('/mock/paykeeper/pay');
  });

  it('🔴 повторный вызов на ТОМ ЖЕ заказе не создаёт нового заказа', async () => {
    const order = fakeOrder();
    for (let i = 0; i < 3; i++) {
      const r = await init(order, { orderNumber: EXISTING_NUMBER, accessToken: token() });
      expect(r.status, `попытка ${i + 1}`).toBe(200);
    }
    expect(initPayment).toHaveBeenCalledTimes(3);
    expect(createOrder, 'эндпоинт оплаты не имеет права создавать заказы').not.toHaveBeenCalled();
    // Каждая инициация — счёт по ТОМУ ЖЕ заказу (номер один и тот же).
    for (const call of initPayment.mock.calls as unknown as [{ number: string }][]) {
      expect(call[0].number).toBe(EXISTING_NUMBER);
    }
  });

  it('🔴 уже оплаченный → 409 order_not_payable, шлюз не трогается', async () => {
    const r = await init(fakeOrder({ paymentStatus: 'paid' }), {
      orderNumber: EXISTING_NUMBER,
      accessToken: token(),
    });
    expect(r.status).toBe(409);
    expect(r.reason).toBe('order_not_payable');
    expect(initPayment).not.toHaveBeenCalled();
  });

  it('🔴 ОТМЕНЁННЫЙ заказ → 409 order_not_payable (а не общий сбой инициации)', async () => {
    const r = await init(fakeOrder({ status: 'cancelled' }), {
      orderNumber: EXISTING_NUMBER,
      accessToken: token(),
    });
    expect(r.status).toBe(409);
    expect(r.reason).toBe('order_not_payable');
    expect(initPayment, 'отменённый заказ не должен доходить до шлюза').not.toHaveBeenCalled();
  });

  it('возвращённый заказ → 409 order_not_payable', async () => {
    const r = await init(fakeOrder({ status: 'refunded', paymentStatus: 'refunded' }), {
      orderNumber: EXISTING_NUMBER,
      accessToken: token(),
    });
    expect(r.status).toBe(409);
    expect(r.reason).toBe('order_not_payable');
    expect(initPayment).not.toHaveBeenCalled();
  });

  it('🔴 SECURITY: чужой токен → тот же 404, шлюз не трогается', async () => {
    const foreign = orderAccessToken('22222222-2222-4222-8222-222222222222', {
      APP_PASSWORD: SECRET,
    });
    const r = await init(fakeOrder(), { orderNumber: EXISTING_NUMBER, accessToken: foreign });
    expect(r.status).toBe(404);
    expect(r.code).toBe('not_found');
    expect(r.reason).toBe('order_not_found');
    expect(initPayment).not.toHaveBeenCalled();
  });

  it('🔴 SECURITY: без токена (голый номер) → 404', async () => {
    const r = await init(fakeOrder(), { orderNumber: EXISTING_NUMBER });
    expect(r.status).toBe(404);
    expect(initPayment).not.toHaveBeenCalled();
  });
});
