import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderAccessToken } from '@/lib/storefront/order-dto';
import { appOriginFromEnv, requestOrigin, resolveMockPageOrigin } from '@/lib/payments/app-origin';
import { mockInitPayment } from '@/lib/payments/tbank/mock';
import { mockCreateInvoice } from '@/lib/payments/paykeeper/mock';
import { mockRegisterOrder } from '@/lib/payments/alfabank/mock';

/**
 * 🟠 РЕГРЕССИЯ РАБОТОСПОСОБНОСТИ ДЕМО-ОПЛАТЫ: в инициации платежа участвуют ДВА
 * РАЗНЫХ адреса, и один не должен подменять другой.
 *
 *   • АДРЕС ВОЗВРАТА (`returnUrl`) — домен ВИТРИНЫ. Уезжает в платёжный шлюз и
 *     превращается в редирект покупателя, поэтому origin берётся ТОЛЬКО из
 *     доверенных настроек владельца (см. tests/payments/init-return-url.security).
 *   • АДРЕС MOCK-СТРАНИЦЫ (`baseOrigin`) — домен ЭТОГО приложения (админки), где
 *     физически лежит `/mock/{tbank,paykeeper,alfabank}/pay`.
 *
 * БАГ (внесён починкой open redirect): `baseOrigin` стал браться из ДОВЕРЕННОГО
 * origin ВИТРИНЫ. На стенде витрина и приложение — РАЗНЫЕ хосты (`erfgv.website`
 * против `admin.erfgv.website`), поэтому demo-ссылка на оплату вела на витрину, где
 * страницы `/mock/<провайдер>/pay` нет: покупатель жал «Оплатить» и попадал в 404.
 *
 * ИНВАРИАНТ: mock-ссылка ведёт на ПРИЛОЖЕНИЕ, адрес возврата — на ВИТРИНУ, и
 * доверенный origin витрины НИКОГДА не подставляется в mock-ссылку.
 *
 * Изоляция: репозиторий заказа, настройки магазина и PaymentService замоканы.
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';
const SECRET = 'token-secret-for-test';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const NUMBER = 'ADMIK-2026-000042';

/** Домены стенда: витрина и приложение (админка) — РАЗНЫЕ хосты. */
const STOREFRONT = 'https://shop.example';
const APP = 'https://admin.shop.example';

const initPayment = vi.fn(async (..._args: unknown[]) => ({
  paymentId: 'mock-pay-1',
  invoiceId: 'mock-inv-1',
  paymentUrl: 'http://x/mock-pay',
  status: 'NEW',
  isMock: true,
}));

const getEffectiveSettings = vi.fn(async () => ({ seo: { site_url: STOREFRONT } }));
const isModuleEffectivelyEnabled = vi.fn(async () => true);

const PROVIDERS = [
  {
    name: 'tbank',
    route: '@/app/api/storefront/v1/payments/tbank/init/route',
    service: '@/lib/payments/tbank/service',
  },
  {
    name: 'paykeeper',
    route: '@/app/api/storefront/v1/payments/paykeeper/init/route',
    service: '@/lib/payments/paykeeper/service',
  },
  {
    name: 'alfabank',
    route: '@/app/api/storefront/v1/payments/alfabank/init/route',
    service: '@/lib/payments/alfabank/service',
  },
] as const;

function fakeOrder() {
  return {
    id: ORDER_ID,
    number: NUMBER,
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
    customerEmail: 'buyer@example.com',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

/** Дёргает init и возвращает opts, с которыми вызван PaymentService.initPayment. */
async function callInit(
  provider: (typeof PROVIDERS)[number],
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ baseOrigin?: string; returnUrl?: string }> {
  vi.resetModules();
  vi.doMock('@/lib/orders/repository', () => ({
    getOrderByNumber: vi.fn(async (n: string) =>
      n === NUMBER ? { order: fakeOrder(), items: [] } : null,
    ),
  }));
  vi.doMock('@/lib/config/settings', () => ({
    getEffectiveSettings,
    isModuleEffectivelyEnabled,
  }));
  vi.doMock(provider.service, () => ({
    PaymentService: class {
      initPayment = initPayment;
    },
  }));
  const { POST } = (await import(provider.route)) as {
    POST: (req: Request) => Promise<Response>;
  };
  const res = await POST(
    new Request('http://app:3000/', {
      method: 'POST',
      headers: {
        'x-storefront-key': KEY,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status, provider.name).toBe(200);
  return (initPayment.mock.calls.at(-1)?.[2] ?? {}) as { baseOrigin?: string; returnUrl?: string };
}

describe.each(PROVIDERS)('payments/$name/init — mock-ссылка и адрес возврата разведены', (provider) => {
  const token = orderAccessToken(ORDER_ID, { APP_PASSWORD: SECRET });

  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog,orders,payments';
    process.env.STOREFRONT_API_KEYS = KEY;
    process.env.STOREFRONT_ALLOWED_ORIGINS = STOREFRONT;
    process.env.APP_PASSWORD = SECRET;
    delete process.env.NEXT_PUBLIC_ADMIK_API_URL;
    initPayment.mockClear();
    getEffectiveSettings.mockResolvedValue({ seo: { site_url: STOREFRONT } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/orders/repository');
    vi.doUnmock('@/lib/config/settings');
    vi.doUnmock(provider.service);
  });

  it('🟠 mock-ссылка ведёт на ПРИЛОЖЕНИЕ, адрес возврата — на ВИТРИНУ', async () => {
    process.env.NEXT_PUBLIC_ADMIK_API_URL = APP;
    const opts = await callInit(
      provider,
      { 'x-forwarded-host': 'admin.shop.example', 'x-forwarded-proto': 'https' },
      { orderNumber: NUMBER, accessToken: token, returnUrl: `${STOREFRONT}/en/cart/success` },
    );
    expect(opts.baseOrigin).toBe(APP);
    expect(new URL(String(opts.returnUrl)).origin).toBe(STOREFRONT);
    // Одно не подменяет другое.
    expect(opts.baseOrigin).not.toBe(new URL(String(opts.returnUrl)).origin);
  });

  it('🟠 доверенный origin ВИТРИНЫ не подставляется в mock-ссылку', async () => {
    // Настройка магазина задана (домен витрины), адреса приложения в env нет —
    // mock-ссылка обязана уйти на origin ЗАПРОСА (сам стенд), а не на витрину.
    const opts = await callInit(
      provider,
      { 'x-forwarded-host': 'admin.stand.example', 'x-forwarded-proto': 'https' },
      { orderNumber: NUMBER, accessToken: token },
    );
    expect(opts.baseOrigin).toBe('https://admin.stand.example');
    expect(opts.baseOrigin).not.toBe(STOREFRONT);
    expect(new URL(String(opts.returnUrl)).origin).toBe(STOREFRONT);
  });

  it('SECURITY: адрес возврата по-прежнему не берётся из заголовков прокси', async () => {
    process.env.NEXT_PUBLIC_ADMIK_API_URL = APP;
    const opts = await callInit(
      provider,
      { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
      {
        orderNumber: NUMBER,
        accessToken: token,
        returnUrl: 'https://evil.test/en/cart/success?number=OTHER&token=stolen',
      },
    );
    expect(String(opts.returnUrl)).not.toContain('evil.test');
    expect(new URL(String(opts.returnUrl)).origin).toBe(STOREFRONT);
    // Подменённый заголовок не перебивает адрес приложения из env владельца.
    expect(opts.baseOrigin).toBe(APP);
  });
});

describe('payments/app-origin — источники адреса приложения', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('берёт публичный адрес Admik из env владельца', () => {
    expect(appOriginFromEnv({ NEXT_PUBLIC_ADMIK_API_URL: `${APP}/` })).toBe(APP);
    expect(appOriginFromEnv({ NEXT_PUBLIC_ADMIK_API_URL: `${APP}/api/storefront/v1` })).toBe(APP);
  });

  it('нераскрытый плейсхолдер и мусор игнорируются', () => {
    expect(appOriginFromEnv({ NEXT_PUBLIC_ADMIK_API_URL: 'https://${ADMIN_DOMAIN}' })).toBeNull();
    expect(appOriginFromEnv({ NEXT_PUBLIC_ADMIK_API_URL: 'admin.shop.example' })).toBeNull();
    expect(appOriginFromEnv({})).toBeNull();
  });

  it('origin запроса: X-Forwarded-* приоритетнее внутреннего req.url', () => {
    const req = new Request('http://app:3000/api', {
      headers: { 'x-forwarded-host': 'admin.shop.example', 'x-forwarded-proto': 'https' },
    });
    expect(requestOrigin(req)).toBe(APP);
    expect(requestOrigin(new Request('http://app:3000/api'))).toBe('http://app:3000');
  });

  it('env приоритетнее заголовков запроса, иначе фолбэк на запрос', () => {
    const req = new Request('http://app:3000/api', {
      headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
    });
    expect(resolveMockPageOrigin(req, { NEXT_PUBLIC_ADMIK_API_URL: APP })).toBe(APP);
    expect(resolveMockPageOrigin(req, {})).toBe('https://evil.test');
  });
});

describe('mock-адаптеры — demo-URL на приложении, возврат на витрине', () => {
  const RETURN_URL = `${STOREFRONT}/en/cart/success?number=${NUMBER}`;

  it('tbank: PaymentURL на приложении, returnUrl внутри — на витрине', () => {
    const url = new URL(
      mockInitPayment({ orderId: NUMBER, amountKop: 150000, baseOrigin: APP, returnUrl: RETURN_URL })
        .paymentUrl,
    );
    expect(url.origin).toBe(APP);
    expect(url.pathname).toBe('/mock/tbank/pay');
    expect(new URL(url.searchParams.get('returnUrl')!).origin).toBe(STOREFRONT);
  });

  it('paykeeper: invoiceUrl на приложении, returnUrl внутри — на витрине', () => {
    const url = new URL(
      mockCreateInvoice({
        orderId: NUMBER,
        payAmount: '1500.00',
        baseOrigin: APP,
        returnUrl: RETURN_URL,
      }).invoiceUrl,
    );
    expect(url.origin).toBe(APP);
    expect(url.pathname).toBe('/mock/paykeeper/pay');
    expect(new URL(url.searchParams.get('returnUrl')!).origin).toBe(STOREFRONT);
  });

  it('alfabank: formUrl на приложении, returnUrl внутри — на витрине', () => {
    const url = new URL(
      mockRegisterOrder({
        orderNumber: NUMBER,
        amountKop: 150000,
        baseOrigin: APP,
        returnUrl: RETURN_URL,
      }).formUrl,
    );
    expect(url.origin).toBe(APP);
    expect(url.pathname).toBe('/mock/alfabank/pay');
    expect(new URL(url.searchParams.get('returnUrl')!).origin).toBe(STOREFRONT);
  });
});
