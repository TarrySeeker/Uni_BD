import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Юнит-тесты сборки АДРЕСА ВОЗВРАТА покупателя с платёжного шлюза
 * (lib/payments/return-url.ts).
 *
 * Зачем: боевой шлюз возвращает покупателя на статический адрес из своего ЛК —
 * без `number`/`token` страница успеха витрины не может показать ни заказ, ни код
 * подарочного сертификата. Адрес обязан собираться СЕРВЕРОМ и содержать параметры
 * заказа.
 *
 * Ключевые инварианты:
 *   • origin берётся ТОЛЬКО из ДОВЕРЕННЫХ источников — настройки магазина
 *     (shop_settings.seo.site_url) или списка доменов витрин, заданного владельцем
 *     в env (STOREFRONT_ALLOWED_ORIGINS). Мультитенантность: никакой константы;
 *   • 🔴 origin из ЗАПРОСА (тело/URL/заголовки прокси) НЕ используется НИКОГДА —
 *     даже когда доверенных источников нет: иначе шлюз уводит покупателя на чужой
 *     сайт с легитимной платёжной формы, унося number и HMAC-token (open redirect);
 *   • путь (локаль витрины) можно взять из адреса, присланного витриной, но ТОЛЬКО
 *     путь и только БЕЗОПАСНЫЙ (без `//`, `\`, управляющих символов);
 *   • `number`/`token` подставляет СЕРВЕР (значения из тела запроса игнорируются);
 *   • нет доверенного origin → адрес НЕ собирается (шлюзу не передаём) + громкий лог;
 *   • отсутствие настройки/мусор в ней не бросает исключение.
 */

import {
  DEFAULT_ORDER_RETURN_PATH,
  buildOrderReturnUrl,
  maskOrderReturnUrl,
  normalizeOrigin,
  safeReturnPath,
} from '@/lib/payments/return-url';

const NUMBER = 'ADMIK-2026-000042';
const TOKEN = 'tok-abcdef0123456789';

describe('payments/return-url — normalizeOrigin', () => {
  it('обрезает путь и хвостовой слэш', () => {
    expect(normalizeOrigin('https://shop.example/')).toBe('https://shop.example');
    expect(normalizeOrigin('https://shop.example/base/')).toBe('https://shop.example');
    expect(normalizeOrigin('  https://shop.example  ')).toBe('https://shop.example');
  });

  it('сохраняет порт и http для стенда', () => {
    expect(normalizeOrigin('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('нераскрытый плейсхолдер .env — НЕ origin (иначе шлюз уводит в никуда)', () => {
    // `new URL('https://${SHOP_DOMAIN}')` парсится успешно: без проверки хоста
    // мисконфигурация давала бы «доверенный» адрес возврата на несуществующий домен.
    expect(normalizeOrigin('https://${SHOP_DOMAIN}')).toBeNull();
    expect(normalizeOrigin('https://shop_domain here')).toBeNull();
  });

  it('IPv6 и localhost остаются допустимыми (стенд/докер)', () => {
    expect(normalizeOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(normalizeOrigin('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('не-http(s) и мусор → null (не бросает)', () => {
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('shop.example')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });
});

describe('payments/return-url — safeReturnPath', () => {
  it('из абсолютного адреса витрины берётся ТОЛЬКО путь (локаль сохраняется)', () => {
    expect(safeReturnPath('https://shop.example/en/cart/success?number=X&token=Y')).toBe(
      '/en/cart/success',
    );
    expect(safeReturnPath('https://evil.test/fr/cart/success')).toBe('/fr/cart/success');
  });

  it('относительный путь принимается как есть', () => {
    expect(safeReturnPath('/fr/cart/success')).toBe('/fr/cart/success');
  });

  it('protocol-relative и мусор → путь по умолчанию', () => {
    expect(safeReturnPath('//evil.test/steal')).toBe(DEFAULT_ORDER_RETURN_PATH);
    expect(safeReturnPath('javascript:alert(1)')).toBe(DEFAULT_ORDER_RETURN_PATH);
    expect(safeReturnPath('')).toBe(DEFAULT_ORDER_RETURN_PATH);
    expect(safeReturnPath(null)).toBe(DEFAULT_ORDER_RETURN_PATH);
  });

  it('SECURITY: обратный слэш — это НЕ путь (new URL трактует `\\` как `/`)', () => {
    // `new URL('/\\evil.test/x', 'https://shop.example')` даёт https://evil.test/x —
    // «относительный путь» уводил бы на чужой хост даже при заданной настройке.
    expect(safeReturnPath('/\\evil.test/steal')).toBe(DEFAULT_ORDER_RETURN_PATH);
    expect(safeReturnPath('/\\\\evil.test')).toBe(DEFAULT_ORDER_RETURN_PATH);
    expect(safeReturnPath('\\\\evil.test')).toBe(DEFAULT_ORDER_RETURN_PATH);
  });

  it('SECURITY: управляющие символы и пробелы в пути → путь по умолчанию', () => {
    // `new URL('/\t/x', origin)` — таб вырезается, остаётся `//x` → чужой хост.
    expect(safeReturnPath('/\t/evil.test')).toBe(DEFAULT_ORDER_RETURN_PATH);
    expect(safeReturnPath('/\n/evil.test')).toBe(DEFAULT_ORDER_RETURN_PATH);
    expect(safeReturnPath('/en/cart success')).toBe(DEFAULT_ORDER_RETURN_PATH);
  });

  it('SECURITY: неправдоподобно длинный путь → путь по умолчанию', () => {
    expect(safeReturnPath(`/${'a'.repeat(4096)}`)).toBe(DEFAULT_ORDER_RETURN_PATH);
  });
});

describe('payments/return-url — buildOrderReturnUrl', () => {
  it('origin из НАСТРОЙКИ магазина + number/token сервера', () => {
    const url = buildOrderReturnUrl({
      orderNumber: NUMBER,
      accessToken: TOKEN,
      siteUrl: 'https://shop.example',
    });
    expect(url).toBe(
      `https://shop.example${DEFAULT_ORDER_RETURN_PATH}?number=${encodeURIComponent(NUMBER)}&token=${TOKEN}`,
    );
  });

  it('НЕ константа: другой магазин → другой адрес возврата', () => {
    const a = buildOrderReturnUrl({ orderNumber: NUMBER, siteUrl: 'https://shop-a.example' });
    const b = buildOrderReturnUrl({ orderNumber: NUMBER, siteUrl: 'https://shop-b.example' });
    expect(a).toContain('https://shop-a.example/');
    expect(b).toContain('https://shop-b.example/');
    expect(a).not.toBe(b);
  });

  it('SECURITY: чужой origin из тела запроса НЕ подменяет адрес, путь берётся', () => {
    const url = buildOrderReturnUrl({
      orderNumber: NUMBER,
      accessToken: TOKEN,
      siteUrl: 'https://shop.example',
      requestedUrl: 'https://evil.test/en/cart/success?number=OTHER&token=stolen',
    });
    expect(url).toBe(
      `https://shop.example/en/cart/success?number=${encodeURIComponent(NUMBER)}&token=${TOKEN}`,
    );
    expect(url).not.toContain('evil.test');
    expect(url).not.toContain('OTHER');
    expect(url).not.toContain('stolen');
  });

  it('🔴 SECURITY: настройки НЕТ → origin из запроса ИГНОРИРУЕТСЯ, адрес не собирается', () => {
    // Именно эта дыра была на демо-стенде: seo.site_url пуст, поэтому origin брался
    // из тела запроса — злоумышленник уводил покупателя с платёжной формы на свой
    // сайт вместе с number и HMAC-token заказа.
    expect(
      buildOrderReturnUrl({
        orderNumber: NUMBER,
        accessToken: TOKEN,
        requestedUrl: 'https://evil.test/fr/cart/success?number=X&token=Y',
      }),
    ).toBeNull();
  });

  it('🔴 SECURITY: даже «похожий на свой» origin из запроса не принимается', () => {
    expect(
      buildOrderReturnUrl({
        orderNumber: NUMBER,
        requestedUrl: 'https://erfgv.website/fr/cart/success',
      }),
    ).toBeNull();
  });

  it('доверенный фолбэк — список доменов витрин владельца (STOREFRONT_ALLOWED_ORIGINS)', () => {
    const url = buildOrderReturnUrl({
      orderNumber: NUMBER,
      accessToken: TOKEN,
      allowedOrigins: ['https://shop.example', 'https://www.shop.example'],
      requestedUrl: 'https://evil.test/fr/cart/success',
    });
    // origin — ПЕРВЫЙ доверенный домен владельца, путь — из запроса (локаль сохранена).
    expect(url).toBe(
      `https://shop.example/fr/cart/success?number=${encodeURIComponent(NUMBER)}&token=${TOKEN}`,
    );
    expect(url).not.toContain('evil.test');
  });

  it('настройка магазина приоритетнее списка доменов из env', () => {
    const url = buildOrderReturnUrl({
      orderNumber: NUMBER,
      siteUrl: 'https://shop.example',
      allowedOrigins: ['https://other.example'],
    });
    expect(url).toContain('https://shop.example/');
  });

  it('мусор в списке доменов пропускается, берётся первый валидный', () => {
    const url = buildOrderReturnUrl({
      orderNumber: NUMBER,
      allowedOrigins: ['не-адрес', 'javascript:alert(1)', 'https://shop.example'],
    });
    expect(url).toContain('https://shop.example/');
  });

  it('без токена доступа параметра token в адресе нет', () => {
    const url = buildOrderReturnUrl({ orderNumber: NUMBER, siteUrl: 'https://shop.example' });
    expect(url).not.toContain('token=');
    expect(url).toContain(`number=${encodeURIComponent(NUMBER)}`);
  });

  it('нет ни одного ДОВЕРЕННОГО origin → null, исключение НЕ бросается', () => {
    expect(buildOrderReturnUrl({ orderNumber: NUMBER })).toBeNull();
    expect(buildOrderReturnUrl({ orderNumber: NUMBER, allowedOrigins: [] })).toBeNull();
  });

  it('мусор в настройке не бросает и не ломает доверенный фолбэк', () => {
    expect(() =>
      buildOrderReturnUrl({ orderNumber: NUMBER, siteUrl: 'не-адрес' }),
    ).not.toThrow();
    expect(
      buildOrderReturnUrl({
        orderNumber: NUMBER,
        siteUrl: 'не-адрес',
        allowedOrigins: ['https://shop.example'],
      }),
    ).toContain('https://shop.example');
  });

  it('🔴 SECURITY: путь с обратным слэшем не уводит с доверенного origin', () => {
    const url = buildOrderReturnUrl({
      orderNumber: NUMBER,
      siteUrl: 'https://shop.example',
      requestedUrl: '/\\evil.test/steal',
    });
    expect(url).toBe(
      `https://shop.example${DEFAULT_ORDER_RETURN_PATH}?number=${encodeURIComponent(NUMBER)}`,
    );
    expect(url).not.toContain('evil.test');
  });

  it('🔴 SECURITY: собранный адрес ВСЕГДА на доверенном origin (инвариант)', () => {
    const hostile = [
      '/\\evil.test/x',
      '//evil.test/x',
      '/\t/evil.test',
      'https://evil.test/x',
      '\\\\evil.test',
      '/%2F%2Fevil.test',
      '/../..//evil.test',
    ];
    for (const requestedUrl of hostile) {
      const url = buildOrderReturnUrl({
        orderNumber: NUMBER,
        siteUrl: 'https://shop.example',
        requestedUrl,
      });
      expect(url, requestedUrl).not.toBeNull();
      expect(new URL(url!).origin, requestedUrl).toBe('https://shop.example');
    }
  });

  it('пустой номер заказа → null (нечего возвращать)', () => {
    expect(buildOrderReturnUrl({ orderNumber: '  ', siteUrl: 'https://shop.example' })).toBeNull();
  });
});

describe('payments/return-url — maskOrderReturnUrl', () => {
  it('маскирует токен доступа перед записью в лог', () => {
    const masked = maskOrderReturnUrl(
      `https://shop.example/cart/success?number=${NUMBER}&token=${TOKEN}`,
    );
    expect(masked).not.toContain(TOKEN);
    expect(masked).toContain(NUMBER);
  });

  it('устойчива к null/мусору', () => {
    expect(maskOrderReturnUrl(null)).toBe('');
    expect(maskOrderReturnUrl('не-адрес')).toBe('не-адрес');
  });
});

describe('payments/return-url — resolveOrderReturnUrl (доверенные источники)', () => {
  const getEffectiveSettings = vi.fn();
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    getEffectiveSettings.mockReset();
    vi.doMock('@/lib/config/settings', () => ({ getEffectiveSettings }));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.doUnmock('@/lib/config/settings');
    vi.resetModules();
  });

  async function resolve(input: Record<string, unknown>, env: Record<string, string> = {}) {
    const mod = await import('@/lib/payments/return-url');
    return mod.resolveOrderReturnUrl(input as never, env);
  }

  it('берёт origin из shop_settings.seo.site_url', async () => {
    getEffectiveSettings.mockResolvedValue({ seo: { site_url: 'https://shop.example' } });
    const url = await resolve({ orderNumber: NUMBER, accessToken: TOKEN });
    expect(url).toBe(
      `https://shop.example${DEFAULT_ORDER_RETURN_PATH}?number=${encodeURIComponent(NUMBER)}&token=${TOKEN}`,
    );
  });

  it('настройки НЕДОСТУПНЫ (нет БД) → не бросает, работает доверенный env-фолбэк', async () => {
    getEffectiveSettings.mockRejectedValue(new Error('DATABASE_URL не задан'));
    const url = await resolve(
      { orderNumber: NUMBER, accessToken: TOKEN },
      { STOREFRONT_ALLOWED_ORIGINS: 'https://shop.example,https://www.shop.example' },
    );
    expect(url).toBe(
      `https://shop.example${DEFAULT_ORDER_RETURN_PATH}?number=${encodeURIComponent(NUMBER)}&token=${TOKEN}`,
    );
  });

  it('🔴 SECURITY: настройка пуста и env пуст → undefined ДАЖЕ при returnUrl из запроса', async () => {
    getEffectiveSettings.mockResolvedValue({ seo: {} });
    expect(
      await resolve({
        orderNumber: NUMBER,
        accessToken: TOKEN,
        requestedUrl: 'https://evil.test/en/cart/success',
      }),
    ).toBeUndefined();
  });

  it('нет доверенного origin → ГРОМКИЙ лог владельцу (что именно задать)', async () => {
    getEffectiveSettings.mockResolvedValue({ seo: {} });
    await resolve({ orderNumber: NUMBER, accessToken: TOKEN });
    expect(warn).toHaveBeenCalled();
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toContain('site_url');
    // Токен доступа в лог не пишем НИКОГДА.
    expect(said).not.toContain(TOKEN);
  });
});
