import { describe, it, expect } from 'vitest';

import {
  SETTING_KEYS,
  SETTING_SCHEMAS,
  i18nSchema,
  parseSettingValue,
} from '@/lib/settings/schemas';

/**
 * T3 — ключ настроек `i18n` (набор языков магазина).
 *
 * До этого пакета ключ существовал только в БД (сид миграции 0036) и НЕ входил в
 * реестр SETTING_KEYS: для него не было ни схемы, ни действия, ни кнопки сброса —
 * языки менялись исключительно SQL-ом. Тесты фиксируют контракт значения:
 * непустой набор, нормализованные теги, отсутствие дублей и обязательное членство
 * defaultLocale в locales (иначе резолв «запрошенный → default» указывал бы на
 * язык, которого в магазине нет).
 */

describe('settings/schemas — реестр знает ключ i18n', () => {
  it('i18n входит в SETTING_KEYS (значит, доступен сброс через resetSetting)', () => {
    expect(SETTING_KEYS).toContain('i18n');
  });

  it('в карте SETTING_SCHEMAS ключу i18n сопоставлена схема', () => {
    expect(SETTING_SCHEMAS.i18n).toBe(i18nSchema);
  });
});

describe('settings/schemas — i18nSchema: валидные наборы', () => {
  it('принимает набор с defaultLocale внутри locales', () => {
    const parsed = i18nSchema.safeParse({ defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      defaultLocale: 'ru',
      locales: ['ru', 'en', 'fr'],
    });
  });

  it('нормализует регистр и пробелы тегов', () => {
    const parsed = i18nSchema.safeParse({ defaultLocale: ' RU ', locales: [' RU ', 'EN'] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.defaultLocale).toBe('ru');
    expect(parsed.success && parsed.data.locales).toEqual(['ru', 'en']);
  });

  it('принимает региональный тег (pt-br) — платформа не ограничена ru/en/fr', () => {
    const parsed = i18nSchema.safeParse({ defaultLocale: 'pt-br', locales: ['pt-br', 'es'] });
    expect(parsed.success).toBe(true);
  });

  it('единственный язык (моноязычный магазин) — валиден', () => {
    const parsed = i18nSchema.safeParse({ defaultLocale: 'de', locales: ['de'] });
    expect(parsed.success).toBe(true);
  });

  it('отбрасывает неизвестные поля (анти-tamper JSONB)', () => {
    const parsed = i18nSchema.safeParse({
      defaultLocale: 'ru',
      locales: ['ru'],
      hacked: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'hacked' in parsed.data).toBe(false);
  });
});

describe('settings/schemas — i18nSchema: невалидные наборы', () => {
  it('пустой список языков отклоняется', () => {
    const parsed = i18nSchema.safeParse({ defaultLocale: 'ru', locales: [] });
    expect(parsed.success).toBe(false);
  });

  it('defaultLocale вне locales отклоняется', () => {
    const parsed = i18nSchema.safeParse({ defaultLocale: 'ru', locales: ['en', 'fr'] });
    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : parsed.error.issues;
    expect(issues.some((i) => i.path[0] === 'defaultLocale')).toBe(true);
  });

  it('дубликаты языков отклоняются (в т.ч. отличающиеся регистром)', () => {
    expect(i18nSchema.safeParse({ defaultLocale: 'ru', locales: ['ru', 'ru'] }).success).toBe(
      false,
    );
    expect(i18nSchema.safeParse({ defaultLocale: 'ru', locales: ['ru', 'RU'] }).success).toBe(
      false,
    );
  });

  it('мусорный тег языка отклоняется', () => {
    for (const bad of ['', ' ', 'русский', 'e', 'en_US', 'en--us', '<script>']) {
      expect(
        i18nSchema.safeParse({ defaultLocale: 'ru', locales: ['ru', bad] }).success,
        `тег «${bad}» не должен проходить`,
      ).toBe(false);
    }
  });

  it('отсутствие обязательных полей отклоняется', () => {
    expect(i18nSchema.safeParse({}).success).toBe(false);
    expect(i18nSchema.safeParse({ locales: ['ru'] }).success).toBe(false);
  });
});

describe('settings/schemas — parseSettingValue(i18n)', () => {
  it('валидное значение строки БД парсится', () => {
    expect(parseSettingValue('i18n', { defaultLocale: 'ru', locales: ['ru', 'en'] })).toEqual({
      defaultLocale: 'ru',
      locales: ['ru', 'en'],
    });
  });

  it('битое значение → null (раздел игнорируется, merge не падает)', () => {
    expect(parseSettingValue('i18n', { locales: 'ru' })).toBeNull();
    expect(parseSettingValue('i18n', undefined)).toBeNull();
  });
});
