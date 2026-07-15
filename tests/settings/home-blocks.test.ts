import { describe, it, expect } from 'vitest';

import { homeSchema } from '@/lib/settings/schemas';
import { mergeSettings } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { getEnv } from '@/lib/config/env';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * Тесты M4 — три новых опциональных блока главной:
 *   tiles     — адаптивные плитки категорий (.dop-links--adaptive);
 *   video     — вставка Vimeo/embed (.mainpage--video);
 *   designers — showcase дизайнеров (.mainpage--designers).
 *
 * Универсальные переиспользуемые блоки (мультитенант): дефолт нейтральный,
 * показ выключен (opt-in), контент приходит из shop_settings.home, не из кода.
 *
 * (а) homeSchema — валидный parse/strip/непустые поля/опциональность.
 * (б) mergeSettings — отсутствие блока → дефолт (скрыт, пусто); частичный оверрайд
 *     добивает внутренние поля дефолтом (avatarTop/workTop = 50, как у valuesStrip/looks).
 * (в) DTO — imageKey → imageUrl (tiles), avatarImageKey/workImageKey → avatarUrl/workUrl
 *     (designers), video.embedUrl проброс как есть; сырые ключи наружу не текут.
 * (г) video.embedUrl не-https → Zod отвергает (анти-XSS iframe src).
 */

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({ NODE_ENV: 'test', SHOP_NAME: 'EnvShop', SHOP_CURRENCY: 'RUB', ...overrides });
}

// =============================================================================
// (а) homeSchema — tiles.
// =============================================================================
describe('settings/schemas — homeSchema.tiles', () => {
  it('принимает валидный блок с плитками', () => {
    const parsed = homeSchema.parse({
      tiles: {
        enabled: true,
        items: [
          { title: 'Платки', href: '/catalog/scarves', imageKey: 'home/tiles/1.webp' },
          { title: 'Сумки', href: '/catalog/bags', imageKey: 'home/tiles/2.webp' },
        ],
      },
    });
    expect(parsed.tiles?.enabled).toBe(true);
    expect(parsed.tiles?.items).toHaveLength(2);
    expect(parsed.tiles?.items?.[0]).toEqual({
      title: 'Платки',
      href: '/catalog/scarves',
      imageKey: 'home/tiles/1.webp',
    });
  });

  it('strip: отбрасывает неизвестные поля блока и плитки', () => {
    const parsed = homeSchema.parse({
      tiles: { enabled: true, bogus: 'x', items: [{ title: 'A', href: '/a', imageKey: 'k.webp', evil: 1 }] },
    });
    expect('bogus' in (parsed.tiles ?? {})).toBe(false);
    expect('evil' in (parsed.tiles!.items![0]!)).toBe(false);
    expect(parsed.tiles!.items![0]).toEqual({ title: 'A', href: '/a', imageKey: 'k.webp' });
  });

  it('плитка требует непустой title/imageKey и валидный href', () => {
    expect(homeSchema.safeParse({ tiles: { items: [{ title: '', href: '/a', imageKey: 'k' }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ tiles: { items: [{ title: 'A', href: '/a', imageKey: '' }] } }).success).toBe(false);
    // href-опечатка без «/» и без протокола → отказ (hrefSchema)
    expect(homeSchema.safeParse({ tiles: { items: [{ title: 'A', href: 'catolog', imageKey: 'k' }] } }).success).toBe(false);
    // нет imageKey → отказ (поле обязательное)
    expect(homeSchema.safeParse({ tiles: { items: [{ title: 'A', href: '/a' }] } }).success).toBe(false);
  });

  it('пустой/опущенный список плиток валиден; весь блок опционален', () => {
    expect(homeSchema.safeParse({ tiles: { enabled: false } }).success).toBe(true);
    expect(homeSchema.safeParse({ tiles: { enabled: true, items: [] } }).success).toBe(true);
    expect(homeSchema.safeParse({}).success).toBe(true);
  });
});

// =============================================================================
// (а) homeSchema — video.
// =============================================================================
describe('settings/schemas — homeSchema.video', () => {
  it('принимает валидный https embed', () => {
    const parsed = homeSchema.parse({
      video: { enabled: true, embedUrl: 'https://player.vimeo.com/video/12345' },
    });
    expect(parsed.video?.enabled).toBe(true);
    expect(parsed.video?.embedUrl).toBe('https://player.vimeo.com/video/12345');
  });

  it('strip: отбрасывает неизвестные поля', () => {
    const parsed = homeSchema.parse({ video: { enabled: false, bogus: 1 } });
    expect('bogus' in (parsed.video ?? {})).toBe(false);
  });

  // (г) Анти-XSS: iframe src не должен принять http/javascript:/data:.
  it('не-https embedUrl отвергается Zod-ом', () => {
    expect(homeSchema.safeParse({ video: { embedUrl: 'http://player.vimeo.com/1' } }).success).toBe(false);
    expect(homeSchema.safeParse({ video: { embedUrl: 'javascript:alert(1)' } }).success).toBe(false);
    expect(homeSchema.safeParse({ video: { embedUrl: 'data:text/html,<script>' } }).success).toBe(false);
    // не-URL строка тоже отвергается
    expect(homeSchema.safeParse({ video: { embedUrl: 'not a url' } }).success).toBe(false);
  });

  it('embedUrl опционален (только enabled валиден)', () => {
    expect(homeSchema.safeParse({ video: { enabled: false } }).success).toBe(true);
  });
});

// =============================================================================
// (а) homeSchema — designers.
// =============================================================================
describe('settings/schemas — homeSchema.designers', () => {
  it('принимает валидный блок с дизайнерами (avatarTop/workTop опц.)', () => {
    const parsed = homeSchema.parse({
      designers: {
        enabled: true,
        title: 'Наши дизайнеры',
        items: [
          {
            name: 'Иван Иванов',
            href: '/designers/ivanov',
            avatarImageKey: 'home/designers/ivanov-avatar.webp',
            workImageKey: 'home/designers/ivanov-work.webp',
            avatarTop: 20,
            workTop: 80,
          },
          {
            name: 'Мария Петрова',
            href: '/designers/petrova',
            avatarImageKey: 'home/designers/petrova-avatar.webp',
            workImageKey: 'home/designers/petrova-work.webp',
          },
        ],
      },
    });
    expect(parsed.designers?.title).toBe('Наши дизайнеры');
    expect(parsed.designers?.items).toHaveLength(2);
    expect(parsed.designers?.items?.[0]?.avatarTop).toBe(20);
    // второй дизайнер без avatarTop/workTop — валиден (опциональны, добьются в merge)
    expect(parsed.designers?.items?.[1]?.avatarTop).toBeUndefined();
  });

  it('strip: отбрасывает неизвестные поля блока и дизайнера', () => {
    const parsed = homeSchema.parse({
      designers: {
        bogus: 'x',
        items: [{ name: 'A', href: '/a', avatarImageKey: 'av', workImageKey: 'wk', evil: 1 }],
      },
    });
    expect('bogus' in (parsed.designers ?? {})).toBe(false);
    expect('evil' in (parsed.designers!.items![0]!)).toBe(false);
  });

  it('дизайнер требует непустые name/avatarImageKey/workImageKey и валидный href', () => {
    expect(homeSchema.safeParse({ designers: { items: [{ name: '', href: '/a', avatarImageKey: 'av', workImageKey: 'wk' }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ designers: { items: [{ name: 'A', href: '/a', avatarImageKey: '', workImageKey: 'wk' }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ designers: { items: [{ name: 'A', href: '/a', avatarImageKey: 'av', workImageKey: '' }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ designers: { items: [{ name: 'A', href: 'bad', avatarImageKey: 'av', workImageKey: 'wk' }] } }).success).toBe(false);
  });

  it('avatarTop/workTop — целое 0..100 (вне диапазона → отказ)', () => {
    const base = { name: 'A', href: '/a', avatarImageKey: 'av', workImageKey: 'wk' };
    expect(homeSchema.safeParse({ designers: { items: [{ ...base, avatarTop: 101 }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ designers: { items: [{ ...base, workTop: -1 }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ designers: { items: [{ ...base, avatarTop: 50.5 }] } }).success).toBe(false);
    expect(homeSchema.safeParse({ designers: { items: [{ ...base, avatarTop: 0, workTop: 100 }] } }).success).toBe(true);
  });

  it('пустой/опущенный список валиден; весь блок опционален', () => {
    expect(homeSchema.safeParse({ designers: { enabled: false } }).success).toBe(true);
    expect(homeSchema.safeParse({ designers: { enabled: true, items: [] } }).success).toBe(true);
    expect(homeSchema.safeParse({}).success).toBe(true);
  });
});

// =============================================================================
// (б) mergeSettings — tiles/video/designers с дефолтами.
// =============================================================================
describe('config/settings — home.tiles/video/designers merge', () => {
  it('отсутствие блоков → дефолты (скрыты, пусты)', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.home.tiles).toEqual(HOME_DEFAULTS.tiles);
    expect(eff.home.video).toEqual(HOME_DEFAULTS.video);
    expect(eff.home.designers).toEqual(HOME_DEFAULTS.designers);
    expect(eff.home.tiles.enabled).toBe(false);
    expect(eff.home.video.enabled).toBe(false);
    expect(eff.home.designers.enabled).toBe(false);
    expect(eff.home.designers.title).toBe('Дизайнеры');
  });

  it('tiles: частичный оверрайд (только enabled) → items из дефолта (пусто)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { tiles: { enabled: true } } },
    ]);
    expect(eff.home.tiles.enabled).toBe(true);
    expect(eff.home.tiles.items).toEqual([]);
  });

  it('tiles: оверрайд с плитками → items из БД, enabled=false по умолчанию', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: { tiles: { items: [{ title: 'Платки', href: '/scarves', imageKey: 'tiles/1.webp' }] } },
      },
    ]);
    expect(eff.home.tiles.enabled).toBe(false);
    expect(eff.home.tiles.items).toEqual([
      { title: 'Платки', href: '/scarves', imageKey: 'tiles/1.webp' },
    ]);
  });

  it('video: оверрайд → embedUrl из БД; отсутствие → пустая строка', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { video: { enabled: true, embedUrl: 'https://player.vimeo.com/video/9' } } },
    ]);
    expect(eff.home.video.enabled).toBe(true);
    expect(eff.home.video.embedUrl).toBe('https://player.vimeo.com/video/9');
  });

  it('designers: merge добивает avatarTop/workTop = 50, если не заданы', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          designers: {
            title: 'Дизайнеры бренда',
            items: [
              { name: 'A', href: '/a', avatarImageKey: 'a-av', workImageKey: 'a-wk' },
              { name: 'B', href: '/b', avatarImageKey: 'b-av', workImageKey: 'b-wk', avatarTop: 10, workTop: 90 },
            ],
          },
        },
      },
    ]);
    expect(eff.home.designers.enabled).toBe(false);
    expect(eff.home.designers.title).toBe('Дизайнеры бренда');
    expect(eff.home.designers.items[0]).toEqual({
      name: 'A',
      href: '/a',
      avatarImageKey: 'a-av',
      workImageKey: 'a-wk',
      avatarTop: 50,
      workTop: 50,
    });
    expect(eff.home.designers.items[1]!.avatarTop).toBe(10);
    expect(eff.home.designers.items[1]!.workTop).toBe(90);
  });

  it('оверрайд другого блока (hero) не трогает новые блоки → дефолты', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { hero: { title: 'Герой' } } },
    ]);
    expect(eff.home.tiles).toEqual(HOME_DEFAULTS.tiles);
    expect(eff.home.video).toEqual(HOME_DEFAULTS.video);
    expect(eff.home.designers).toEqual(HOME_DEFAULTS.designers);
  });
});

// =============================================================================
// (в) DTO — резолв ключей в URL + passthrough видео.
// =============================================================================
describe('storefront/settings-dto — home.tiles/video/designers', () => {
  it('tiles: imageKey → imageUrl, сырой ключ наружу не течёт', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          tiles: {
            enabled: true,
            items: [{ title: 'Платки', href: '/scarves', imageKey: 'tiles/1.webp' }],
          },
        },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.tiles.enabled).toBe(true);
    expect(dto.home.tiles.items).toEqual([
      { title: 'Платки', href: '/scarves', imageUrl: 'https://cdn.test/tiles/1.webp' },
    ]);
    const json = JSON.stringify(dto.home.tiles);
    expect(json).not.toContain('imageKey');
    expect(json).not.toContain('"tiles/1.webp"');
  });

  it('video: embedUrl проброс как есть (это уже URL)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { video: { enabled: true, embedUrl: 'https://player.vimeo.com/video/7' } } },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.video).toEqual({ enabled: true, embedUrl: 'https://player.vimeo.com/video/7' });
  });

  it('designers: avatarImageKey/workImageKey → avatarUrl/workUrl, ключи наружу не текут', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          designers: {
            enabled: true,
            title: 'Дизайнеры',
            items: [
              {
                name: 'Иван',
                href: '/designers/ivan',
                avatarImageKey: 'des/ivan-av.webp',
                workImageKey: 'des/ivan-wk.webp',
                avatarTop: 30,
                workTop: 70,
              },
            ],
          },
        },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.designers.enabled).toBe(true);
    expect(dto.home.designers.title).toBe('Дизайнеры');
    expect(dto.home.designers.items).toEqual([
      {
        name: 'Иван',
        href: '/designers/ivan',
        avatarUrl: 'https://cdn.test/des/ivan-av.webp',
        workUrl: 'https://cdn.test/des/ivan-wk.webp',
        avatarTop: 30,
        workTop: 70,
      },
    ]);
    const json = JSON.stringify(dto.home.designers);
    expect(json).not.toContain('ImageKey');
    expect(json).not.toContain('"des/ivan-av.webp"');
  });

  it('дефолт (нет оверрайда) → блоки выключены и пусты', () => {
    const dto = toPublicSettingsDto(mergeSettings(envWith(), []));
    expect(dto.home.tiles).toEqual({ enabled: false, items: [] });
    expect(dto.home.video).toEqual({ enabled: false, embedUrl: '' });
    expect(dto.home.designers).toEqual({ enabled: false, title: HOME_DEFAULTS.designers.title, items: [] });
  });
});
