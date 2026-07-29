import { describe, it, expect } from 'vitest';

import { homeSchema } from '@/lib/settings/schemas';
import { mergeSettings } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { getEnv } from '@/lib/config/env';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * «Образы» v2 — вкладки-категории + карусель карточек «автор + фото».
 *
 * Новая модель данных (АДДИТИВНО поверх ТЗ_2):
 *   looks.categories: [{ id?, title, text?, imageKey? }]  — вкладки-фильтры
 *   looks.items:      [{ categoryId, imageKey, authorName, authorAvatarKey? }] — карточки
 *
 * 🔴 ОБРАТНАЯ СОВМЕСТИМОСТЬ (у carre на стенде уже заведены данные в СТАРОМ
 * формате `categories:[{title,text,imageKey}]`, без items): merge обязан
 * АВТОМАТИЧЕСКИ мигрировать такие данные в новый формат при чтении —
 * каждая старая категория даёт вкладку И одну карточку с её фото. Порядок
 * категорий сохраняется (по нему content_i18n мержит переводы ПО ИНДЕКСУ —
 * перестановка порушила бы переводы живого сайта).
 *
 * (а) homeSchema.looks — новые поля валидны, старые продолжают проходить.
 * (б) mergeSettings — авто-миграция легаси, id-автогенерация, сирот отбрасываем.
 * (в) DTO — items отдают imageUrl/authorAvatarUrl, сырые S3-ключи наружу не текут.
 */

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({ NODE_ENV: 'test', SHOP_NAME: 'EnvShop', SHOP_CURRENCY: 'RUB', ...overrides });
}

const LEGACY_LOOKS = {
  enabled: true,
  title: 'Образы',
  categories: [
    { title: 'Спорт', text: 'Спортивные образы', imageKey: 'looks/sport.webp' },
    { title: 'В офис', text: 'Деловые образы', imageKey: 'looks/office.webp' },
  ],
};

// =============================================================================
// (а) Схема: новые поля + совместимость со старыми.
// =============================================================================
describe('settings/schemas — homeSchema.looks v2 (вкладки + карточки)', () => {
  it('принимает новый формат: категории с id и карточки с автором', () => {
    const parsed = homeSchema.parse({
      looks: {
        enabled: true,
        title: 'Образы',
        categories: [
          { id: 'sport', title: 'Спорт' },
          { id: 'office', title: 'В офис' },
        ],
        items: [
          {
            categoryId: 'sport',
            imageKey: 'looks/1.webp',
            authorName: 'Анна',
            authorAvatarKey: 'looks/av1.webp',
          },
          { categoryId: 'office', imageKey: 'looks/2.webp', authorName: 'Борис' },
        ],
      },
    });
    expect(parsed.looks?.categories).toEqual([
      { id: 'sport', title: 'Спорт' },
      { id: 'office', title: 'В офис' },
    ]);
    expect(parsed.looks?.items).toHaveLength(2);
    expect(parsed.looks?.items?.[0]).toEqual({
      categoryId: 'sport',
      imageKey: 'looks/1.webp',
      authorName: 'Анна',
      authorAvatarKey: 'looks/av1.webp',
    });
    // authorAvatarKey опционален (аватар может быть не загружен).
    expect(parsed.looks?.items?.[1]?.authorAvatarKey).toBeUndefined();
  });

  it('СТАРЫЙ формат (title+text+imageKey, без items) по-прежнему валиден', () => {
    const parsed = homeSchema.parse({ looks: LEGACY_LOOKS });
    expect(parsed.looks?.categories).toEqual(LEGACY_LOOKS.categories);
    expect(parsed.looks?.items).toBeUndefined();
  });

  it('категория v2 не требует text/imageKey (вкладка = только заголовок)', () => {
    expect(homeSchema.safeParse({ looks: { categories: [{ title: 'Спорт' }] } }).success).toBe(true);
  });

  it('категория всё ещё требует непустой title', () => {
    expect(homeSchema.safeParse({ looks: { categories: [{ title: '' }] } }).success).toBe(false);
    expect(
      homeSchema.safeParse({ looks: { categories: [{ id: 'x', title: '   ' }] } }).success,
    ).toBe(false);
  });

  it('карточка требует непустые categoryId / imageKey / authorName', () => {
    const bad = (item: Record<string, unknown>) =>
      homeSchema.safeParse({ looks: { items: [item] } }).success;
    expect(bad({ categoryId: '', imageKey: 'k', authorName: 'A' })).toBe(false);
    expect(bad({ categoryId: 'c', imageKey: '', authorName: 'A' })).toBe(false);
    expect(bad({ categoryId: 'c', imageKey: 'k', authorName: '' })).toBe(false);
    expect(bad({ categoryId: 'c', imageKey: 'k' })).toBe(false);
    expect(bad({ categoryId: 'c', imageKey: 'k', authorName: 'A' })).toBe(true);
  });

  it('strip: неизвестные поля категории и карточки отброшены', () => {
    const parsed = homeSchema.parse({
      looks: {
        categories: [{ id: 'a', title: 'A', evil: 1 }],
        items: [{ categoryId: 'a', imageKey: 'k', authorName: 'N', evil: 2 }],
      },
    });
    expect('evil' in parsed.looks!.categories![0]!).toBe(false);
    expect('evil' in parsed.looks!.items![0]!).toBe(false);
  });

  it('пустой список карточек валиден; весь блок остаётся опциональным', () => {
    expect(homeSchema.safeParse({ looks: { items: [] } }).success).toBe(true);
    expect(homeSchema.safeParse({}).success).toBe(true);
  });
});

// =============================================================================
// (б) merge: миграция легаси + нормализация.
// =============================================================================
describe('config/settings — home.looks миграция старого формата', () => {
  const merge = (looks: unknown) =>
    mergeSettings(envWith(), [{ setting_key: 'home', value: { looks } }]).home.looks;

  it('дефолт: категории и карточки пусты, блок выключен', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.home.looks).toEqual(HOME_DEFAULTS.looks);
    expect(eff.home.looks.items).toEqual([]);
    expect(eff.home.looks.categories).toEqual([]);
  });

  it('🔴 ЛЕГАСИ: категории со старой формой → вкладки + по карточке на категорию', () => {
    const looks = merge(LEGACY_LOOKS);
    expect(looks.enabled).toBe(true);
    expect(looks.title).toBe('Образы');
    // Порядок категорий СОХРАНЁН (иначе переводы content_i18n по индексу поедут).
    expect(looks.categories.map((c) => c.title)).toEqual(['Спорт', 'В офис']);
    // id автогенерирован и стабилен (по позиции), text/imageKey сохранены.
    expect(looks.categories[0]!.id).toBeTruthy();
    expect(looks.categories[0]!.text).toBe('Спортивные образы');
    expect(looks.categories[0]!.imageKey).toBe('looks/sport.webp');
    // Контент живого сайта не пропал: фото каждой категории стало карточкой.
    expect(looks.items).toHaveLength(2);
    expect(looks.items[0]!.imageKey).toBe('looks/sport.webp');
    expect(looks.items[0]!.categoryId).toBe(looks.categories[0]!.id);
    expect(looks.items[1]!.imageKey).toBe('looks/office.webp');
    expect(looks.items[1]!.categoryId).toBe(looks.categories[1]!.id);
  });

  it('легаси-миграция НЕ выдумывает имя автора (пусто → владелец заполнит)', () => {
    const looks = merge(LEGACY_LOOKS);
    expect(looks.items[0]!.authorName).toBe('');
    expect(looks.items[0]!.authorAvatarKey).toBe('');
  });

  it('НОВЫЙ формат (есть items) миграцию НЕ запускает — карточки как заданы', () => {
    const looks = merge({
      enabled: true,
      categories: [
        { id: 'sport', title: 'Спорт' },
        { id: 'party', title: 'На вечеринку' },
      ],
      items: [
        { categoryId: 'party', imageKey: 'k1', authorName: 'Анна', authorAvatarKey: 'a1' },
      ],
    });
    expect(looks.items).toEqual([
      { categoryId: 'party', imageKey: 'k1', authorName: 'Анна', authorAvatarKey: 'a1' },
    ]);
    expect(looks.categories).toEqual([
      { id: 'sport', title: 'Спорт', text: '', imageKey: '' },
      { id: 'party', title: 'На вечеринку', text: '', imageKey: '' },
    ]);
  });

  it('категория без id получает автогенерированный непустой уникальный id', () => {
    const looks = merge({
      categories: [{ title: 'Спорт' }, { title: 'В офис' }],
      items: [],
    });
    const ids = looks.categories.map((c) => c.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('карточка-сирота (categoryId не совпал ни с одной вкладкой) отброшена', () => {
    const looks = merge({
      categories: [{ id: 'sport', title: 'Спорт' }],
      items: [
        { categoryId: 'sport', imageKey: 'k1', authorName: 'A' },
        { categoryId: 'ghost', imageKey: 'k2', authorName: 'B' },
      ],
    });
    expect(looks.items).toHaveLength(1);
    expect(looks.items[0]!.imageKey).toBe('k1');
  });

  it('частичный оверрайд (только enabled) → title из дефолта, списки пусты', () => {
    const looks = merge({ enabled: true });
    expect(looks.enabled).toBe(true);
    expect(looks.title).toBe(HOME_DEFAULTS.looks.title);
    expect(looks.categories).toEqual([]);
    expect(looks.items).toEqual([]);
  });
});

// =============================================================================
// (в) DTO: карточки наружу.
// =============================================================================
describe('storefront/settings-dto — home.looks.items', () => {
  it('карточки отдают imageUrl/authorAvatarUrl, сырые ключи наружу не текут', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          looks: {
            enabled: true,
            title: 'Образы',
            categories: [{ id: 'sport', title: 'Спорт' }],
            items: [
              {
                categoryId: 'sport',
                imageKey: 'looks/1.webp',
                authorName: 'Анна',
                authorAvatarKey: 'looks/av1.webp',
              },
            ],
          },
        },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    // Легаси-поля категории остаются в контракте, но пусты (v2-вкладка = заголовок).
    expect(dto.home.looks.categories).toEqual([
      { id: 'sport', title: 'Спорт', text: '', imageUrl: '' },
    ]);
    expect(dto.home.looks.items).toEqual([
      {
        categoryId: 'sport',
        imageUrl: 'https://cdn.test/looks/1.webp',
        authorName: 'Анна',
        authorAvatarUrl: 'https://cdn.test/looks/av1.webp',
      },
    ]);
    const json = JSON.stringify(dto.home.looks);
    expect(json).not.toContain('imageKey');
    expect(json).not.toContain('authorAvatarKey');
    expect(json).not.toContain('"looks/1.webp"');
  });

  it('карточка без аватара → authorAvatarUrl === null (не пустой URL резолва)', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: {
          looks: {
            enabled: true,
            categories: [{ id: 'c', title: 'C' }],
            items: [{ categoryId: 'c', imageKey: 'k.webp', authorName: 'A' }],
          },
        },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.looks.items[0]!.authorAvatarUrl).toBeNull();
  });

  it('🔴 ЛЕГАСИ через DTO: контент старого магазина доезжает до витрины карточками', () => {
    const eff = mergeSettings(envWith(), [{ setting_key: 'home', value: { looks: LEGACY_LOOKS } }]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.looks.categories.map((c) => c.title)).toEqual(['Спорт', 'В офис']);
    expect(dto.home.looks.items.map((i) => i.imageUrl)).toEqual([
      'https://cdn.test/looks/sport.webp',
      'https://cdn.test/looks/office.webp',
    ]);
    // Старый контракт категорий (title/text/imageUrl) сохранён — витрины/клиенты,
    // ещё не знающие про items, не ломаются.
    expect(dto.home.looks.categories[0]!.text).toBe('Спортивные образы');
    expect(dto.home.looks.categories[0]!.imageUrl).toBe('https://cdn.test/looks/sport.webp');
  });

  it('дефолт (нет оверрайда) → блок выключен, категории и карточки пусты', () => {
    const dto = toPublicSettingsDto(mergeSettings(envWith(), []));
    expect(dto.home.looks.enabled).toBe(false);
    expect(dto.home.looks.categories).toEqual([]);
    expect(dto.home.looks.items).toEqual([]);
  });
});
