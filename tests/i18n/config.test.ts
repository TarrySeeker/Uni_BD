import { describe, it, expect } from 'vitest';

import {
  DEFAULT_LOCALE_CONFIG,
  normalizeLocale,
  parseLocaleConfig,
  resolveRequestLocale,
  getLocaleConfig,
} from '@/lib/i18n/config';
import type { LocaleConfig } from '@/lib/i18n/types';

/**
 * i18n config (ADR-i18n, docs/24 §1): парсинг shop_settings.i18n с env-дефолтом
 * и валидация членства запрошенного языка. Чисто, без БД.
 */

describe('parseLocaleConfig', () => {
  it('валидная конфигурация проходит и нормализуется', () => {
    const cfg = parseLocaleConfig({ defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] });
    expect(cfg.defaultLocale).toBe('ru');
    expect(cfg.locales).toEqual(['ru', 'en', 'fr']);
  });

  it('приводит теги к нижнему регистру и дедуплицирует', () => {
    const cfg = parseLocaleConfig({ defaultLocale: 'RU', locales: ['RU', 'ru', 'EN', 'en'] });
    expect(cfg.defaultLocale).toBe('ru');
    expect(cfg.locales).toEqual(['ru', 'en']);
  });

  it('defaultLocale, отсутствующий в locales, добавляется в набор', () => {
    const cfg = parseLocaleConfig({ defaultLocale: 'ru', locales: ['en', 'fr'] });
    expect(cfg.defaultLocale).toBe('ru');
    expect(cfg.locales).toContain('ru');
    expect(cfg.locales[0]).toBe('ru');
  });

  it.each([
    ['null', null],
    ['не объект (строка)', 'ru'],
    ['пустой объект', {}],
    ['пустой список языков', { defaultLocale: 'ru', locales: [] }],
    ['locales не массив', { defaultLocale: 'ru', locales: 'ru' }],
    ['нет defaultLocale', { locales: ['ru'] }],
  ])('битое значение (%s) → DEFAULT_LOCALE_CONFIG', (_label, raw) => {
    expect(parseLocaleConfig(raw)).toEqual(DEFAULT_LOCALE_CONFIG);
  });
});

describe('resolveRequestLocale — валидация членства', () => {
  const cfg: LocaleConfig = { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] };

  it('язык из набора возвращается как есть', () => {
    expect(resolveRequestLocale('en', cfg)).toBe('en');
    expect(resolveRequestLocale('fr', cfg)).toBe('fr');
  });

  it('регистр и пробелы нормализуются', () => {
    expect(resolveRequestLocale('  EN  ', cfg)).toBe('en');
  });

  it('фолбэк на первичный subtag (en-US → en)', () => {
    expect(resolveRequestLocale('en-US', cfg)).toBe('en');
    expect(resolveRequestLocale('fr-CA', cfg)).toBe('fr');
  });

  it('язык вне набора → defaultLocale', () => {
    expect(resolveRequestLocale('de', cfg)).toBe('ru');
    expect(resolveRequestLocale('xx', cfg)).toBe('ru');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['пустая строка', ''],
    ['пробелы', '   '],
  ])('отсутствие/пустой ввод (%s) → defaultLocale', (_label, raw) => {
    expect(resolveRequestLocale(raw as string | null | undefined, cfg)).toBe('ru');
  });

  it('уважает нестандартный defaultLocale', () => {
    const en: LocaleConfig = { defaultLocale: 'en', locales: ['en', 'fr'] };
    expect(resolveRequestLocale('de', en)).toBe('en');
    expect(resolveRequestLocale('fr', en)).toBe('fr');
  });
});

describe('normalizeLocale', () => {
  it('обрезает пробелы и понижает регистр', () => {
    expect(normalizeLocale('  FR ')).toBe('fr');
  });
});

describe('getLocaleConfig — чтение с инъекцией reader', () => {
  it('валидное значение из reader парсится', async () => {
    const cfg = await getLocaleConfig(async () => ({
      defaultLocale: 'ru',
      locales: ['ru', 'en'],
    }));
    expect(cfg.locales).toEqual(['ru', 'en']);
  });

  it('reader вернул null → DEFAULT_LOCALE_CONFIG', async () => {
    expect(await getLocaleConfig(async () => null)).toEqual(DEFAULT_LOCALE_CONFIG);
  });

  it('reader бросил → DEFAULT_LOCALE_CONFIG (не пробрасывает ошибку)', async () => {
    expect(
      await getLocaleConfig(async () => {
        throw new Error('db down');
      }),
    ).toEqual(DEFAULT_LOCALE_CONFIG);
  });

  it('reader вернул мусор → DEFAULT_LOCALE_CONFIG', async () => {
    expect(await getLocaleConfig(async () => ({ nope: true }))).toEqual(DEFAULT_LOCALE_CONFIG);
  });
});
