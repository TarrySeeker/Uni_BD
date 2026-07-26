import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderAccessToken } from '@/lib/storefront/order-dto';

/**
 * 🔴 SECURITY — OPEN REDIRECT в адресе возврата с платёжного шлюза.
 *
 * БАГ (внесён починкой «страница успеха не видит заказ»): роуты init собирали
 * адрес возврата с фолбэком на origin ИЗ ЗАПРОСА (тело `returnUrl`, заголовок
 * X-Forwarded-Host), а на демо-стенде настройка `shop_settings.seo.site_url` НЕ
 * ЗАДАНА — то есть фолбэк был рабочей веткой по умолчанию. Злоумышленник
 * инициировал оплату своего заказа с подменённым origin, и шлюз возвращал
 * покупателя на ЧУЖОЙ сайт прямо с легитимной платёжной формы, унося `number` и
 * HMAC-`token` заказа в query. Вторая ветка утечки — `returnUrl: resolved ?? returnUrl`:
 * когда доверенного адреса нет, шлюзу уезжало СЫРОЕ значение из тела запроса.
 *
 * ИНВАРИАНТ: до шлюза доезжает адрес ТОЛЬКО на доверенном origin (настройка
 * магазина или STOREFRONT_ALLOWED_ORIGINS владельца). Нет доверенного origin →
 * шлюзу не передаётся НИЧЕГО (как было до правки), а не значение из запроса.
 *
 * Изоляция: репозиторий заказа, настройки магазина и PaymentService замоканы.
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';
const SECRET = 'token-secret-for-test';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const NUMBER = 'ADMIK-2026-000042';
const EVIL = 'https://evil.test/en/cart/success?number=OTHER&token=stolen';

const initPayment = vi.fn(async (..._args: unknown[]) => ({
  paymentId: 'mock-pay-1',
  invoiceId: 'mock-inv-1',
  paymentUrl: 'http://x/mock-pay',
  status: 'NEW',
  isMock: true,
}));

/** seo.site_url НЕ задан — ровно конфигурация демо-стенда. */
const getEffectiveSettings = vi.fn(async () => ({ seo: {} }));
/** Модуль payments включён (гейт runStorefront живёт в том же модуле настроек). */
const isModuleEffectivelyEnabled = vi.fn(async () => true);

const PROVIDERS = [
  { name: 'tbank', route: '@/app/api/storefront/v1/payments/tbank/init/route', service: '@/lib/payments/tbank/service' },
  { name: 'paykeeper', route: '@/app/api/storefront/v1/payments/paykeeper/init/route', service: '@/lib/payments/paykeeper/service' },
  { name: 'alfabank', route: '@/app/api/storefront/v1/payments/alfabank/init/route', service: '@/lib/payments/alfabank/service' },
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

async function callInit(
  provider: (typeof PROVIDERS)[number],
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
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
        // Подменённый заголовок прокси — origin запроса тоже недоверенный.
        'x-forwarded-host': 'evil.test',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status, provider.name).toBe(200);
  return initPayment.mock.calls.at(-1)?.[2] as Record<string, unknown> | undefined;
}

describe.each(PROVIDERS)('payments/$name/init — адрес возврата не уводит покупателя', (provider) => {
  const token = orderAccessToken(ORDER_ID, { APP_PASSWORD: SECRET });

  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog,orders,payments';
    process.env.STOREFRONT_API_KEYS = KEY;
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    process.env.APP_PASSWORD = SECRET;
    initPayment.mockClear();
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

  it('🔴 нет доверенного origin → шлюзу НЕ передаётся адрес из запроса', async () => {
    const opts = await callInit(provider, {
      orderNumber: NUMBER,
      accessToken: token,
      returnUrl: EVIL,
    });
    expect(opts?.returnUrl).toBeUndefined();
    // baseOrigin — ДРУГОЕ поле и другой риск: он абсолютизирует ссылку MOCK-режима на
    // demo-страницу ЭТОГО приложения, которую получает сам вызывающий, и в боевой шлюз
    // не уходит (см. lib/payments/app-origin.ts). Без адреса приложения в env он
    // остаётся на фолбэке из запроса — то есть злоумышленник «уводит» только себя.
    expect(opts?.baseOrigin).toBe('https://evil.test');
  });

  it('доверенный origin из STOREFRONT_ALLOWED_ORIGINS → адрес на СВОЁМ домене', async () => {
    process.env.STOREFRONT_ALLOWED_ORIGINS = 'https://shop.example';
    const opts = await callInit(provider, {
      orderNumber: NUMBER,
      accessToken: token,
      returnUrl: EVIL,
    });
    const url = String(opts?.returnUrl ?? '');
    expect(new URL(url).origin).toBe('https://shop.example');
    // Путь (локаль) из запроса сохранён, а number/token — серверные.
    expect(new URL(url).pathname).toBe('/en/cart/success');
    expect(new URL(url).searchParams.get('number')).toBe(NUMBER);
    expect(new URL(url).searchParams.get('token')).toBe(token);
    expect(url).not.toContain('OTHER');
    expect(url).not.toContain('stolen');
    // 🟠 А вот mock-ссылка на domain ВИТРИНЫ вести НЕ должна: demo-страница оплаты
    // (app/mock/<провайдер>/pay) живёт в ЭТОМ приложении, на другом хосте стенда.
    // Подстановка сюда доверенного origin витрины ломала демо-оплату (404) —
    // см. tests/payments/init-mock-page-origin.test.ts.
    expect(opts?.baseOrigin).not.toBe('https://shop.example');
    expect(opts?.baseOrigin).toBe('https://evil.test');
  });
});
