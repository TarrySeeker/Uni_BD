import { describe, it, expect } from 'vitest';

import {
  LANGUAGE_LIBRARY,
  localeLabel,
  isValidLocaleTag,
  buildLanguageOptions,
  toggleLocale,
  addCustomLocale,
  buildI18nPayload,
} from '@/app/admin/(panel)/settings/_components/languages-form-state';

/**
 * T3 — чистая логика формы «Языки» (тестов React-компонентов в проекте нет:
 * vitest environment 'node', поэтому вся логика вынесена из LanguagesForm.tsx).
 *
 * Ключевые инварианты: справочник языков — ПЛАТФОРМЕННЫЙ (не набор конкретного
 * магазина), уже включённые магазином языки видны даже если их нет в справочнике,
 * язык по умолчанию нельзя выключить, а payload всегда содержит его в locales.
 */

describe('languages-form-state — справочник языков', () => {
  it('справочник платформы, а не набор carre: заметно больше трёх языков', () => {
    expect(LANGUAGE_LIBRARY.length).toBeGreaterThan(10);
  });

  it('коды уникальны, нормализованы и валидны, метки непусты', () => {
    const codes = LANGUAGE_LIBRARY.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const { code, label } of LANGUAGE_LIBRARY) {
      expect(code).toBe(code.trim().toLowerCase());
      expect(isValidLocaleTag(code)).toBe(true);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('localeLabel: известный код → название, неизвестный → сам код', () => {
    expect(localeLabel('ru')).toBe('Русский');
    expect(localeLabel('xx')).toBe('xx');
  });
});

describe('languages-form-state — isValidLocaleTag', () => {
  it('принимает валидные теги', () => {
    for (const tag of ['ru', 'en', 'fr', 'pt-br', 'zh-hans']) {
      expect(isValidLocaleTag(tag), tag).toBe(true);
    }
  });

  it('отклоняет мусор', () => {
    for (const tag of ['', ' ', 'e', 'русский', 'en_US', 'en--us', '<script>']) {
      expect(isValidLocaleTag(tag), tag).toBe(false);
    }
  });
});

describe('languages-form-state — buildLanguageOptions', () => {
  const config = { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] };

  it('язык по умолчанию идёт первым и помечен isDefault', () => {
    const options = buildLanguageOptions(config);
    expect(options[0].code).toBe('ru');
    expect(options[0].isDefault).toBe(true);
    expect(options.filter((o) => o.isDefault)).toHaveLength(1);
  });

  it('включённые языки помечены enabled, остальные из справочника — нет', () => {
    const options = buildLanguageOptions(config);
    const byCode = Object.fromEntries(options.map((o) => [o.code, o]));
    expect(byCode.en.enabled).toBe(true);
    expect(byCode.fr.enabled).toBe(true);
    expect(byCode.de.enabled).toBe(false);
  });

  it('язык магазина вне справочника платформы всё равно показан', () => {
    const options = buildLanguageOptions({ defaultLocale: 'ru', locales: ['ru', 'qq'] });
    const custom = options.find((o) => o.code === 'qq');
    expect(custom).toBeDefined();
    expect(custom?.enabled).toBe(true);
    expect(custom?.label).toBe('qq');
  });

  it('коды не дублируются', () => {
    const codes = buildLanguageOptions(config).map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('магазин с другим дефолтом обслуживается так же (мультитенантность)', () => {
    const options = buildLanguageOptions({ defaultLocale: 'de', locales: ['de', 'en'] });
    expect(options[0].code).toBe('de');
    expect(options[0].isDefault).toBe(true);
  });
});

describe('languages-form-state — toggleLocale', () => {
  it('включает и выключает язык', () => {
    expect(toggleLocale(['ru'], 'en', true, 'ru')).toEqual(['ru', 'en']);
    expect(toggleLocale(['ru', 'en'], 'en', false, 'ru')).toEqual(['ru']);
  });

  it('язык по умолчанию выключить нельзя (иначе набор без канона)', () => {
    expect(toggleLocale(['ru', 'en'], 'ru', false, 'ru')).toEqual(['ru', 'en']);
  });

  it('повторное включение не создаёт дубликат', () => {
    expect(toggleLocale(['ru', 'en'], 'en', true, 'ru')).toEqual(['ru', 'en']);
  });
});

describe('languages-form-state — addCustomLocale', () => {
  it('добавляет нормализованный тег', () => {
    const res = addCustomLocale(['ru'], ' PT-BR ');
    expect(res.ok).toBe(true);
    expect(res.enabled).toEqual(['ru', 'pt-br']);
  });

  it('отклоняет мусорный тег с сообщением', () => {
    const res = addCustomLocale(['ru'], 'русский');
    expect(res.ok).toBe(false);
    expect(res.enabled).toEqual(['ru']);
    expect(res.error).toBeTruthy();
  });

  it('отклоняет уже добавленный язык', () => {
    const res = addCustomLocale(['ru', 'en'], 'EN');
    expect(res.ok).toBe(false);
    expect(res.enabled).toEqual(['ru', 'en']);
  });
});

describe('languages-form-state — buildI18nPayload', () => {
  it('всегда включает язык по умолчанию и ставит его первым', () => {
    expect(buildI18nPayload({ defaultLocale: 'ru', enabled: ['en', 'fr'] })).toEqual({
      defaultLocale: 'ru',
      locales: ['ru', 'en', 'fr'],
    });
  });

  it('нормализует и дедуплицирует теги', () => {
    expect(buildI18nPayload({ defaultLocale: ' RU ', enabled: ['EN', 'en', 'ru'] })).toEqual({
      defaultLocale: 'ru',
      locales: ['ru', 'en'],
    });
  });

  it('моноязычный набор допустим', () => {
    expect(buildI18nPayload({ defaultLocale: 'ru', enabled: [] })).toEqual({
      defaultLocale: 'ru',
      locales: ['ru'],
    });
  });
});
