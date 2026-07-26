import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderAccessToken } from '@/lib/storefront/order-dto';

/**
 * POST /api/storefront/v1/payments/paykeeper/init — АДРЕС ВОЗВРАТА покупателя.
 *
 * Проверяется, что роут не пробрасывает в шлюз адрес из тела запроса «как есть», а
 * пересобирает его: origin — ТОЛЬКО из доверенных источников владельца (настройка
 * магазина shop_settings.seo.site_url, иначе STOREFRONT_ALLOWED_ORIGINS; заголовки
 * прокси НЕ доверенные), путь — из адреса витрины (локаль), number/token — серверные.
 * Нет доверенного origin → шлюзу не передаём ничего. Плюс политика токена:
 * доступ по email не должен превращаться в токен (коды подарочных сертификатов
 * выдаются только по токену).
 *
 * Изоляция: репозиторий заказов, PaymentService и настройки замоканы (без БД/сети).
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';
const TOKEN_SECRET = 'token-secret-for-test';

const EXISTING_ID = '11111111-1111-4111-8111-111111111111';
const EXISTING_NUMBER = 'ADMIK-2026-000042';
const CUSTOMER_EMAIL = 'buyer@example.com';

function setEnv() {
  process.env.ADMIK_MODULES = 'catalog,orders,payments';
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  process.env.APP_PASSWORD = TOKEN_SECRET;
  delete process.env.PAYKEEPER_LOGIN;
  delete process.env.PAYKEEPER_PASSWORD;
}

const initPayment = vi.fn(async () => ({
  invoiceId: 'mock-inv-1',
  paymentUrl: 'http://x/mock/paykeeper/pay',
  status: 'sent',
  isMock: true,
}));

const getEffectiveSettings = vi.fn();

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/orders/repository', () => ({
    getOrderByNumber: vi.fn(async (n: string) =>
      n === EXISTING_NUMBER
        ? {
            order: {
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
            },
            items: [],
          }
        : null,
    ),
  }));
  vi.doMock('@/lib/payments/paykeeper/service', () => ({
    PaymentService: class {
      initPayment = initPayment;
    },
  }));
  // Частичный мок: подменяем ТОЛЬКО чтение настроек, module-gate остаётся настоящим.
  vi.doMock('@/lib/config/settings', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getEffectiveSettings,
  }));
  return import('@/app/api/storefront/v1/payments/paykeeper/init/route');
}

async function init(body: unknown): Promise<{ status: number; returnUrl?: string }> {
  const { POST } = await loadRoute();
  const res = await POST(
    new Request('http://internal-app:3000/', {
      method: 'POST',
      headers: {
        'x-storefront-key': KEY,
        'content-type': 'application/json',
        'x-forwarded-host': 'api.example',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify(body),
    }),
  );
  const call = initPayment.mock.calls[0] as unknown as [unknown, unknown, { returnUrl?: string }];
  const opts = call?.[2];
  return { status: res.status, returnUrl: opts?.returnUrl };
}

const token = () => orderAccessToken(EXISTING_ID, { APP_PASSWORD: TOKEN_SECRET });

describe('paykeeper/init — адрес возврата покупателя', () => {
  beforeEach(() => {
    setEnv();
    getEffectiveSettings.mockResolvedValue({ seo: { site_url: 'https://shop.example' } });
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
    vi.doUnmock('@/lib/payments/paykeeper/service');
    vi.doUnmock('@/lib/config/settings');
    initPayment.mockClear();
    getEffectiveSettings.mockReset();
  });

  it('origin из настройки магазина, путь из витрины, number/token серверные', async () => {
    const r = await init({
      orderNumber: EXISTING_NUMBER,
      accessToken: token(),
      returnUrl: 'https://shop.example/en/cart/success?number=X&token=Y',
    });
    expect(r.status).toBe(200);
    expect(r.returnUrl).toBe(
      `https://shop.example/en/cart/success?number=${encodeURIComponent(EXISTING_NUMBER)}&token=${token()}`,
    );
  });

  it('SECURITY: чужой origin в теле не подменяет адрес возврата', async () => {
    const r = await init({
      orderNumber: EXISTING_NUMBER,
      accessToken: token(),
      returnUrl: 'https://evil.test/en/cart/success?number=X&token=Y',
    });
    expect(r.returnUrl).toContain('https://shop.example/en/cart/success');
    expect(r.returnUrl).not.toContain('evil.test');
  });

  it('SECURITY: доступ по email НЕ выдаёт токен заказа в адрес возврата', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER, email: CUSTOMER_EMAIL });
    expect(r.status).toBe(200);
    expect(r.returnUrl).toContain(`number=${encodeURIComponent(EXISTING_NUMBER)}`);
    expect(r.returnUrl).not.toContain('token=');
  });

  it('витрина адрес не прислала → путь по умолчанию из настройки магазина', async () => {
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.returnUrl).toBe(
      `https://shop.example/cart/success?number=${encodeURIComponent(EXISTING_NUMBER)}&token=${token()}`,
    );
  });

  it('🔴 SECURITY: настройка не задана → адрес НЕ строится из заголовков прокси', async () => {
    // РАНЬШЕ здесь ожидался origin из X-Forwarded-Host — и это была дыра: заголовок
    // производен от клиентского Host, Caddy его дописывает, а не затирает. Оплата
    // по-прежнему проходит (200), просто шлюзу адрес не передаётся.
    getEffectiveSettings.mockResolvedValue({ seo: {} });
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(200);
    expect(r.returnUrl).toBeUndefined();
  });

  it('настройка не задана, но заданы домены витрины в env → адрес на своём домене', async () => {
    getEffectiveSettings.mockResolvedValue({ seo: {} });
    process.env.STOREFRONT_ALLOWED_ORIGINS = 'https://shop.example';
    const r = await init({ orderNumber: EXISTING_NUMBER, accessToken: token() });
    expect(r.status).toBe(200);
    expect(r.returnUrl).toBe(
      `https://shop.example/cart/success?number=${encodeURIComponent(EXISTING_NUMBER)}&token=${token()}`,
    );
  });
});
