import { describe, it, expect } from 'vitest';

import { homeSchema } from '@/lib/settings/schemas';
import { mergeSettings } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { getEnv } from '@/lib/config/env';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * Тесты ТЗ_2 «Образы» (lookbook) — новый опциональный блок главной `home.looks`.
 *
 * Универсальный переиспользуемый блок: опц. заголовок + список категорий, каждая
 * категория = фото (imageKey) + заголовок + абзац. Никакого хардкода под магазин —
 * дефолт нейтральный (пустой список категорий, показ выключен).
 *
 * (а) homeSchema.looks — валидность/strip/непустые поля категории/опциональность.
 * (б) mergeSettings — отсутствие блока → дефолт (скрыт, пусто); частичный оверрайд
 *     добивает внутренние поля дефолтом (как valuesStrip).
 * (в) DTO — категории отдают imageUrl (резолв ключа), сырой imageKey наружу не течёт.
 */

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({ NODE_ENV: 'test', SHOP_NAME: 'EnvShop', SHOP_CURRENCY: 'RUB', ...overrides });
}

// =============================================================================
// (а) homeSchema.looks.
// =============================================================================
describe('settings/schemas — homeSchema.looks', () => {
  it('принимает валидный блок с категориями', () => {
    const parsed = homeSchema.parse({
      looks: {
        enabled: true,
        title: 'Образы',
        categories: [
          { title: 'Классика', text: 'Описание образа', imageKey: 'home/looks/1.webp' },
          { title: 'Кэжуал', text: 'Ещё один образ', imageKey: 'home/looks/2.webp' },
        ],
      },
    });
    expect(parsed.looks?.enabled).toBe(true);
    expect(parsed.looks?.title).toBe('Образы');
    expect(parsed.looks?.categories).toHaveLength(2);
    expect(parsed.looks?.categories?.[0]).toEqual({
      title: 'Классика',
      text: 'Описание образа',
      imageKey: 'home/looks/1.webp',
    });
  });

  it('strip: отбрасывает неизвестные поля блока и категории', () => {
    const parsed = homeSchema.parse({
      looks: {
        enabled: true,
        bogus: 'x',
        categories: [{ title: 'A', text: 'B', imageKey: 'k.webp', evil: 1 }],
      },
    });
    expect('bogus' in (parsed.looks ?? {})).toBe(false);
    expect('evil' in (parsed.looks!.categories![0]!)).toBe(false);
    expect(parsed.looks!.categories![0]).toEqual({ title: 'A', text: 'B', imageKey: 'k.webp' });
  });

  it('категория требует непустой title', () => {
    expect(
      homeSchema.safeParse({ looks: { categories: [{ title: '', text: 'B', imageKey: 'k' }] } }).success,
    ).toBe(false);
  });

  it('категория требует непустой text', () => {
    expect(
      homeSchema.safeParse({ looks: { categories: [{ title: 'A', text: '', imageKey: 'k' }] } }).success,
    ).toBe(false);
  });

  it('категория требует непустой imageKey', () => {
    expect(
      homeSchema.safeParse({ looks: { categories: [{ title: 'A', text: 'B', imageKey: '' }] } }).success,
    ).toBe(false);
  });

  // v2 («Образы» = вкладки + карусель): вкладке достаточно title — text/imageKey
  // ослаблены до опциональных. Обязательность СНЯТА намеренно, старые данные с
  // тремя полями по-прежнему валидны (см. tests/settings/home-looks-tabs.test.ts).
  it('категория без text/imageKey валидна (вкладка = только заголовок)', () => {
    expect(
      homeSchema.safeParse({ looks: { categories: [{ title: 'A', text: 'B' }] } }).success,
    ).toBe(true);
    expect(homeSchema.safeParse({ looks: { categories: [{ title: 'A' }] } }).success).toBe(true);
  });

  it('пустой/опущенный список категорий валиден', () => {
    expect(homeSchema.safeParse({ looks: { enabled: false } }).success).toBe(true);
    expect(homeSchema.safeParse({ looks: { enabled: true, categories: [] } }).success).toBe(true);
    // весь блок опционален
    expect(homeSchema.safeParse({}).success).toBe(true);
  });
});

// =============================================================================
// (б) mergeSettings — looks с дефолтами.
// =============================================================================
describe('config/settings — home.looks merge', () => {
  it('отсутствие блока → дефолт (скрыт, пустые категории)', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.home.looks).toEqual(HOME_DEFAULTS.looks);
    expect(eff.home.looks.enabled).toBe(false);
    expect(eff.home.looks.categories).toEqual([]);
  });

  it('частичный оверрайд (только enabled) → title/categories из дефолта', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { looks: { enabled: true } } },
    ]);
    expect(eff.home.looks.enabled).toBe(true);
    expect(eff.home.looks.title).toBe(HOME_DEFAULTS.looks.title);
    expect(eff.home.looks.categories).toEqual([]);
  });

  it('оверрайд с категориями → категории из БД, enabled=false по умолчанию', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          looks: {
            title: 'Наши образы',
            categories: [{ title: 'Лето', text: 'Летние образы', imageKey: 'looks/summer.webp' }],
          },
        },
      },
    ]);
    expect(eff.home.looks.enabled).toBe(false);
    expect(eff.home.looks.title).toBe('Наши образы');
    // v2: merge добивает категории машинным id (автоген по позиции) и мигрирует
    // легаси-фото в карточку карусели — контент старых магазинов не теряется.
    expect(eff.home.looks.categories).toEqual([
      { id: 'cat-0', title: 'Лето', text: 'Летние образы', imageKey: 'looks/summer.webp' },
    ]);
    expect(eff.home.looks.items).toEqual([
      { categoryId: 'cat-0', imageKey: 'looks/summer.webp', authorName: '', authorAvatarKey: '' },
    ]);
  });

  it('оверрайд другого блока (hero) не трогает looks → looks = дефолт', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { hero: { title: 'Герой' } } },
    ]);
    expect(eff.home.looks).toEqual(HOME_DEFAULTS.looks);
  });
});

// =============================================================================
// (в) DTO — looks наружу (imageKey → imageUrl).
// =============================================================================
describe('storefront/settings-dto — home.looks', () => {
  it('категории отдают imageUrl (резолв ключа), сырой ключ наружу не течёт', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          looks: {
            enabled: true,
            title: 'Образы',
            categories: [
              { title: 'Классика', text: 'Текст 1', imageKey: 'looks/1.webp' },
              { title: 'Кэжуал', text: 'Текст 2', imageKey: 'looks/2.webp' },
            ],
          },
        },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.looks.enabled).toBe(true);
    expect(dto.home.looks.title).toBe('Образы');
    expect(dto.home.looks.categories).toEqual([
      { id: 'cat-0', title: 'Классика', text: 'Текст 1', imageUrl: 'https://cdn.test/looks/1.webp' },
      { id: 'cat-1', title: 'Кэжуал', text: 'Текст 2', imageUrl: 'https://cdn.test/looks/2.webp' },
    ]);
    const json = JSON.stringify(dto.home.looks);
    expect(json).not.toContain('imageKey');
    expect(json).not.toContain('"looks/1.webp"');
  });

  it('дефолт (нет оверрайда) → looks выключен, категории и карточки пусты', () => {
    const dto = toPublicSettingsDto(mergeSettings(envWith(), []));
    expect(dto.home.looks).toEqual({
      enabled: false,
      title: HOME_DEFAULTS.looks.title,
      categories: [],
      items: [],
    });
  });
});
