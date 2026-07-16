import { describe, it, expect } from 'vitest';

import { homeSchema } from '@/lib/settings/schemas';
import { mergeSettings } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { getEnv } from '@/lib/config/env';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * Тесты M5 — два новых опциональных блока главной (доводят её до 1:1 с carre):
 *   slider   — промо-слайдер (.mainpage--slider), массив слайдов;
 *   corpCert — «Корпоративным / сертификаты» (.dop-links--vertical), плитки-ссылки.
 *
 * Универсальные переиспользуемые блоки (мультитенант): дефолт нейтральный, показ
 * выключен (opt-in), контент приходит из shop_settings.home, не из кода.
 *
 * (а) homeSchema — валидный parse/strip/непустые обязательные поля/опциональность.
 * (б) href-валидатор (internalHrefSchema) — принимает /path и https://, ОТВЕРГАЕТ
 *     http://other, javascript:, mailto:, опечатку без «/» (анти-XSS/open-redirect).
 * (в) mergeSettings — отсутствие блока → дефолт (скрыт, пусто); частичный оверрайд
 *     добивает внутренние поля (name/caption = '' если не заданы).
 * (г) DTO — imageKey → imageUrl (slider/corpCert); сырые ключи наружу не текут.
 */

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({ NODE_ENV: 'test', SHOP_NAME: 'EnvShop', SHOP_CURRENCY: 'RUB', ...overrides });
}

// =============================================================================
// (а) homeSchema — slider.
// =============================================================================
describe('settings/schemas — homeSchema.slider', () => {
  it('принимает валидный блок со слайдами (name/caption опц.)', () => {
    const parsed = homeSchema.parse({
      slider: {
        enabled: true,
        slides: [
          { imageKey: 'home/slider/1.webp', href: '/search?q=caviar', caption: 'Всем по икре' },
          { imageKey: 'home/slider/2.webp', href: 'https://shop.ru/promo', name: 'Промо', caption: 'Скидки' },
        ],
      },
    });
    expect(parsed.slider?.enabled).toBe(true);
    expect(parsed.slider?.slides).toHaveLength(2);
    // первый слайд без name — валиден (name опц.)
    expect(parsed.slider?.slides?.[0]).toEqual({
      imageKey: 'home/slider/1.webp',
      href: '/search?q=caviar',
      caption: 'Всем по икре',
    });
    expect(parsed.slider?.slides?.[0]?.name).toBeUndefined();
  });

  it('strip: отбрасывает неизвестные поля блока и слайда', () => {
    const parsed = homeSchema.parse({
      slider: { enabled: true, bogus: 'x', slides: [{ imageKey: 'k', href: '/a', evil: 1 }] },
    });
    expect('bogus' in (parsed.slider ?? {})).toBe(false);
    expect('evil' in (parsed.slider!.slides![0]!)).toBe(false);
    expect(parsed.slider!.slides![0]).toEqual({ imageKey: 'k', href: '/a' });
  });

  it('слайд требует непустой imageKey и валидный href', () => {
    // нет imageKey → отказ (обязателен)
    expect(homeSchema.safeParse({ slider: { slides: [{ href: '/a' }] } }).success).toBe(false);
    // пустой imageKey → отказ
    expect(homeSchema.safeParse({ slider: { slides: [{ imageKey: '', href: '/a' }] } }).success).toBe(false);
    // нет href → отказ (обязателен)
    expect(homeSchema.safeParse({ slider: { slides: [{ imageKey: 'k' }] } }).success).toBe(false);
  });

  it('пустой/опущенный список слайдов валиден; весь блок опционален', () => {
    expect(homeSchema.safeParse({ slider: { enabled: false } }).success).toBe(true);
    expect(homeSchema.safeParse({ slider: { enabled: true, slides: [] } }).success).toBe(true);
    expect(homeSchema.safeParse({}).success).toBe(true);
  });

  // (б) Анти-XSS/анти-open-redirect: href слайда — только /path или https://.
  it('href слайда: принимает /path и https://, отвергает http/javascript/mailto/опечатку', () => {
    const ok = (href: string) =>
      homeSchema.safeParse({ slider: { slides: [{ imageKey: 'k', href }] } }).success;
    // допустимые
    expect(ok('/search?q=caviar')).toBe(true);
    expect(ok('/#anchor')).toBe(true);
    expect(ok('https://shop.ru/promo')).toBe(true);
    // недопустимые
    expect(ok('http://evil.com')).toBe(false); // http (open-redirect/mixed)
    expect(ok('javascript:alert(1)')).toBe(false); // XSS
    expect(ok('data:text/html,<script>')).toBe(false); // data-URI
    expect(ok('mailto:a@b.ru')).toBe(false); // не навигационный маршрут
    expect(ok('catalog')).toBe(false); // опечатка без «/»
    expect(ok('//evil.com')).toBe(false); // protocol-relative = скрытый open-redirect на чужой хост
  });
});

// =============================================================================
// (а) homeSchema — corpCert.
// =============================================================================
describe('settings/schemas — homeSchema.corpCert', () => {
  it('принимает валидный блок с плитками', () => {
    const parsed = homeSchema.parse({
      corpCert: {
        enabled: true,
        tiles: [
          { imageKey: 'home/corp.webp', href: '/corporate', title: 'Корпоративным клиентам' },
          { imageKey: 'home/cert.webp', href: '/certificates', title: 'Подарочные сертификаты' },
        ],
      },
    });
    expect(parsed.corpCert?.enabled).toBe(true);
    expect(parsed.corpCert?.tiles).toHaveLength(2);
    expect(parsed.corpCert?.tiles?.[0]).toEqual({
      imageKey: 'home/corp.webp',
      href: '/corporate',
      title: 'Корпоративным клиентам',
    });
  });

  it('strip: отбрасывает неизвестные поля блока и плитки', () => {
    const parsed = homeSchema.parse({
      corpCert: { enabled: true, bogus: 'x', tiles: [{ imageKey: 'k', href: '/a', title: 'T', evil: 1 }] },
    });
    expect('bogus' in (parsed.corpCert ?? {})).toBe(false);
    expect('evil' in (parsed.corpCert!.tiles![0]!)).toBe(false);
    expect(parsed.corpCert!.tiles![0]).toEqual({ imageKey: 'k', href: '/a', title: 'T' });
  });

  it('плитка требует непустой imageKey/title и валидный href', () => {
    expect(homeSchema.safeParse({ corpCert: { tiles: [{ imageKey: '', href: '/a', title: 'T' }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ corpCert: { tiles: [{ imageKey: 'k', href: '/a', title: '' }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ corpCert: { tiles: [{ imageKey: 'k', href: '/a' }] } }).success).toBe(false); // нет title
    expect(homeSchema.safeParse({ corpCert: { tiles: [{ imageKey: 'k', title: 'T' }] } }).success).toBe(false); // нет href
  });

  it('пустой/опущенный список плиток валиден; весь блок опционален', () => {
    expect(homeSchema.safeParse({ corpCert: { enabled: false } }).success).toBe(true);
    expect(homeSchema.safeParse({ corpCert: { enabled: true, tiles: [] } }).success).toBe(true);
    expect(homeSchema.safeParse({}).success).toBe(true);
  });

  // (б) Анти-XSS/анти-open-redirect: href плитки — только /path или https://.
  it('href плитки: принимает /path и https://, отвергает http/javascript/опечатку', () => {
    const ok = (href: string) =>
      homeSchema.safeParse({ corpCert: { tiles: [{ imageKey: 'k', href, title: 'T' }] } }).success;
    expect(ok('/corporate')).toBe(true);
    expect(ok('https://shop.ru/corp')).toBe(true);
    expect(ok('http://evil.com')).toBe(false);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('corporate')).toBe(false); // опечатка без «/»
  });
});

// =============================================================================
// (в) mergeSettings — slider/corpCert с дефолтами.
// =============================================================================
describe('config/settings — home.slider/corpCert merge', () => {
  it('отсутствие блоков → дефолты (скрыты, пусты)', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.home.slider).toEqual(HOME_DEFAULTS.slider);
    expect(eff.home.corpCert).toEqual(HOME_DEFAULTS.corpCert);
    expect(eff.home.slider.enabled).toBe(false);
    expect(eff.home.corpCert.enabled).toBe(false);
    expect(eff.home.slider.slides).toEqual([]);
    expect(eff.home.corpCert.tiles).toEqual([]);
  });

  it('slider: частичный оверрайд (только enabled) → slides из дефолта (пусто)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { slider: { enabled: true } } },
    ]);
    expect(eff.home.slider.enabled).toBe(true);
    expect(eff.home.slider.slides).toEqual([]);
  });

  it('slider: merge добивает name/caption = "" если не заданы', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          slider: {
            enabled: true,
            slides: [
              { imageKey: 'home/caviar.webp', href: '/search?q=caviar', caption: 'Всем по икре' },
            ],
          },
        },
      },
    ]);
    expect(eff.home.slider.enabled).toBe(true);
    expect(eff.home.slider.slides[0]).toEqual({
      imageKey: 'home/caviar.webp',
      href: '/search?q=caviar',
      name: '',
      caption: 'Всем по икре',
    });
  });

  it('corpCert: оверрайд с плитками → tiles из БД, enabled=false по умолчанию', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          corpCert: {
            tiles: [
              { imageKey: 'home/corp.webp', href: '/corporate', title: 'Корпоративным клиентам' },
              { imageKey: 'home/cert.webp', href: '/certificates', title: 'Подарочные сертификаты' },
            ],
          },
        },
      },
    ]);
    expect(eff.home.corpCert.enabled).toBe(false);
    expect(eff.home.corpCert.tiles).toEqual([
      { imageKey: 'home/corp.webp', href: '/corporate', title: 'Корпоративным клиентам' },
      { imageKey: 'home/cert.webp', href: '/certificates', title: 'Подарочные сертификаты' },
    ]);
  });

  it('оверрайд другого блока (hero) не трогает новые блоки → дефолты', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { hero: { title: 'Герой' } } },
    ]);
    expect(eff.home.slider).toEqual(HOME_DEFAULTS.slider);
    expect(eff.home.corpCert).toEqual(HOME_DEFAULTS.corpCert);
  });
});

// =============================================================================
// (г) DTO — резолв ключей в URL; сырые ключи наружу не текут.
// =============================================================================
describe('storefront/settings-dto — home.slider/corpCert', () => {
  it('slider: imageKey → imageUrl, сырой ключ наружу не течёт', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          slider: {
            enabled: true,
            slides: [{ imageKey: 'slider/1.webp', href: '/search?q=caviar', caption: 'Всем по икре' }],
          },
        },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.slider.enabled).toBe(true);
    expect(dto.home.slider.slides).toEqual([
      { imageUrl: 'https://cdn.test/slider/1.webp', href: '/search?q=caviar', name: '', caption: 'Всем по икре' },
    ]);
    const json = JSON.stringify(dto.home.slider);
    expect(json).not.toContain('imageKey');
    expect(json).not.toContain('"slider/1.webp"');
  });

  it('corpCert: imageKey → imageUrl, ключи наружу не текут', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          corpCert: {
            enabled: true,
            tiles: [
              { imageKey: 'corp/1.webp', href: '/corporate', title: 'Корпоративным клиентам' },
            ],
          },
        },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.corpCert.enabled).toBe(true);
    expect(dto.home.corpCert.tiles).toEqual([
      { imageUrl: 'https://cdn.test/corp/1.webp', href: '/corporate', title: 'Корпоративным клиентам' },
    ]);
    const json = JSON.stringify(dto.home.corpCert);
    expect(json).not.toContain('imageKey');
    expect(json).not.toContain('"corp/1.webp"');
  });

  it('дефолт (нет оверрайда) → блоки выключены и пусты', () => {
    const dto = toPublicSettingsDto(mergeSettings(envWith(), []));
    expect(dto.home.slider).toEqual({ enabled: false, slides: [] });
    expect(dto.home.corpCert).toEqual({ enabled: false, tiles: [] });
  });
});
