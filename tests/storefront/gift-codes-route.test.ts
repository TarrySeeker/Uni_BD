import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Трек T7 — GET /api/storefront/v1/orders/:number/gift-codes.
 *
 * Эндпоинт отдаёт ДЕНЬГИ НА ПРЕДЪЯВИТЕЛЯ, поэтому тесты сторожат периметр:
 *  - без ?token= → 404 (никакой информации о существовании заказа);
 *  - ?email= покупателя (штатный путь трекинга) для кода НЕ работает: номера
 *    заказов последовательны, а email покупателей есть в БД;
 *  - чужой токен → 404;
 *  - payment_status != 'paid' → состояние pending, но кода нет;
 *  - Cache-Control: no-store (иначе код осядет в прокси/бэк-кнопке);
 *  - собственный жёсткий rate-limit (общий 600/мин на IP для перебора мал);
 *  - код НЕ попадает в аргументы логгера.
 *
 * Всё замокано (БД не нужна).
 */

const ORDER_ID = 'd81f1540-1800-49de-a5c1-c08368787686';
const ITEM_ID = 'f5eafff9-7402-4386-9d6f-ca1cc5701faf';
const NUMBER = 'GA-2026-000123';
const CODE = 'SECRETCODE1234';
const KEY = 'sk_secret';
const ORIGINAL = { ...process.env };

const order = {
  id: ORDER_ID,
  number: NUMBER,
  status: 'paid',
  paymentStatus: 'paid',
  customerEmail: 'Ivan@Example.COM',
  currency: 'RUB',
};

const item = {
  id: ITEM_ID,
  orderId: ORDER_ID,
  nameSnapshot: 'Подарочный сертификат 3000',
  skuSnapshot: 'GIFT-3000',
  attributesSnapshot: { gift_certificate: true },
  unitPrice: '3000.00',
  quantity: 1,
  lineTotal: '3000.00',
};

const cert = {
  id: '6dbc9eb3-9c13-46ee-9214-baa583708261',
  code: CODE,
  initialAmount: '3000.00',
  spentTotal: '0.00',
  remaining: '3000.00',
  currency: 'RUB',
  status: 'active',
  validUntil: null,
  issuedOrderId: ORDER_ID,
  issuedOrderItemId: ITEM_ID,
  purchaser: { name: 'Иван Петров', email: 'ivan@example.com', phone: null },
  recipient: { name: null, email: null, phone: null },
};

const state = {
  order: { ...order } as Record<string, unknown>,
  items: [item] as unknown[],
  certs: [cert] as unknown[],
};

const getOrderByNumber = vi.fn(async (num: string) =>
  num === NUMBER ? { order: state.order, items: state.items } : null,
);
const listGiftCertificatesIssuedForOrder = vi.fn(async () => state.certs);
const getSetting = vi.fn(async () => ({ value: { autoIssue: true } }));

const logCalls: unknown[][] = [];
const logger = {
  debug: (...a: unknown[]) => logCalls.push(a),
  info: (...a: unknown[]) => logCalls.push(a),
  warn: (...a: unknown[]) => logCalls.push(a),
  error: (...a: unknown[]) => logCalls.push(a),
  child: () => logger,
};

vi.mock('@/lib/orders/repository', () => ({ getOrderByNumber }));
vi.mock('@/lib/gift-certificates/repository', () => ({ listGiftCertificatesIssuedForOrder }));
vi.mock('@/lib/settings/repository', () => ({ getSetting }));
vi.mock('@/lib/logger', () => ({ logger, createLogger: () => logger }));

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/storefront/v1/orders/[number]/gift-codes/route');
}

/** Токен считаем тем же алгоритмом, что и прод (env фиксирован в setEnv). */
async function validToken(): Promise<string> {
  const { orderAccessToken } = await import('@/lib/storefront/order-dto');
  return orderAccessToken(ORDER_ID);
}

function setEnv() {
  process.env.ADMIK_MODULES = 'catalog,orders,cdek';
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  process.env.APP_PASSWORD = 'test-secret';
  process.env.ORDER_TOKEN_SECRET = 'test-secret';
  delete process.env.REDIS_URL;
}

async function get(
  query: string,
  ip = '203.0.113.7',
): Promise<{ status: number; body: any; res: Response }> {
  const { GET } = await loadRoute();
  const req = new Request(
    `http://x/api/storefront/v1/orders/${NUMBER}/gift-codes${query}`,
    { headers: { 'x-storefront-key': KEY, 'x-forwarded-for': ip } },
  );
  const res = await GET(req, { params: Promise.resolve({ number: NUMBER }) });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body, res };
}

describe('GET /orders/:number/gift-codes — периметр выдачи кода', () => {
  beforeEach(() => {
    setEnv();
    state.order = { ...order };
    state.items = [item];
    state.certs = [cert];
    logCalls.length = 0;
    getOrderByNumber.mockClear();
    listGiftCertificatesIssuedForOrder.mockClear();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  it('🔴 без token → 404, сертификаты даже не читаются', async () => {
    const r = await get('');
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain(CODE);
    expect(listGiftCertificatesIssuedForOrder).not.toHaveBeenCalled();
  });

  it('🔴 ?email= покупателя (валидный для трекинга) кода НЕ даёт → 404', async () => {
    const r = await get('?email=ivan%40example.com');
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain(CODE);
    expect(listGiftCertificatesIssuedForOrder).not.toHaveBeenCalled();
  });

  it('🔴 чужой (подобранный) токен → 404', async () => {
    const r = await get(`?token=${'a'.repeat(32)}`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain(CODE);
  });

  it('верный токен + оплачено → 200 с кодом, Cache-Control: no-store', async () => {
    const r = await get(`?token=${await validToken()}`);
    expect(r.status).toBe(200);
    expect(r.body?.data?.state).toBe('ready');
    expect(r.body?.data?.codes?.[0]?.code).toBe(CODE);
    expect(r.res.headers.get('cache-control')).toContain('no-store');
  });

  it('🔴 заказ не оплачен → 200 pending, кода в ответе нет', async () => {
    state.order = { ...order, paymentStatus: 'pending', status: 'awaiting_payment' };
    const r = await get(`?token=${await validToken()}`);
    expect(r.status).toBe(200);
    expect(r.body?.data?.state).toBe('pending');
    expect(r.body?.data?.codes).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain(CODE);
  });

  it('несуществующий заказ → 404 (тот же ответ, что и «нет доступа»)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(
      new Request('http://x/api/storefront/v1/orders/NOPE/gift-codes?token=zzz', {
        headers: { 'x-storefront-key': KEY },
      }),
      { params: Promise.resolve({ number: 'NOPE' }) },
    );
    expect(res.status).toBe(404);
  });

  it('🔴 код не попадает в аргументы логгера', async () => {
    await get(`?token=${await validToken()}`);
    expect(JSON.stringify(logCalls)).not.toContain(CODE);
  });

  it('🔴 собственный жёсткий rate-limit: перебор с одного IP упирается в 429', async () => {
    const { GIFT_CODES_RATE_LIMIT } = await import('@/lib/storefront/gift-order-codes');
    const { GET } = await loadRoute();
    const call = () =>
      GET(
        new Request(`http://x/api/storefront/v1/orders/${NUMBER}/gift-codes?token=bad`, {
          headers: { 'x-storefront-key': KEY, 'x-forwarded-for': '198.51.100.9' },
        }),
        { params: Promise.resolve({ number: NUMBER }) },
      );
    let last = 200;
    for (let i = 0; i <= GIFT_CODES_RATE_LIMIT.maxAttempts; i++) {
      last = (await call()).status;
    }
    expect(last).toBe(429);
    // Порог заведомо ниже общего storefront-лимита (600/мин), иначе перебор
    // токенов ограничивался бы только им.
    expect(GIFT_CODES_RATE_LIMIT.maxAttempts).toBeLessThan(600);
  });
});
