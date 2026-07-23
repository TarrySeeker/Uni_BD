import { describe, expect, it } from 'vitest';

import {
  LOCALES,
  DEFAULT_LOCALE,
  enabledLocalesFrom,
  alternatesFor,
} from '../../storefront/lib/i18n';

// ЮНИТ: связка витрины с настройкой языков магазина (волна 5).
//
// Модель (принята): код витрины поддерживает whitelist ru/en/fr (LOCALES), а
// РЕАЛЬНО показываемый набор = пересечение settings.i18n.locales (из админки) с
// этим whitelist. Выключение языка в админке убирает его из набора → витрина
// перестаёт рендерить переключатель/hreflang для него. Добавление 4-го языка —
// ВНЕ охвата волны: незнакомый код молча отбрасывается (union Locale не ослаблен).

describe('enabledLocalesFrom — enabled-набор = пересечение конфига с whitelist', () => {
  it('полный набор проходит как есть', () => {
    expect(enabledLocalesFrom(['ru', 'en', 'fr'])).toEqual(['ru', 'en', 'fr']);
  });

  it('отсутствующий в конфиге язык ИСКЛЮЧЁН (выключен в админке)', () => {
    expect(enabledLocalesFrom(['ru'])).toEqual(['ru']);
    expect(enabledLocalesFrom(['ru', 'en'])).toEqual(['ru', 'en']);
  });

  it('лишний код в конфиге (4-й язык / мусор) ИГНОРИРУЕТСЯ', () => {
    expect(enabledLocalesFrom(['ru', 'en', 'de'])).toEqual(['ru', 'en']);
    expect(enabledLocalesFrom(['ru', 'zz', 'fr'])).toEqual(['ru', 'fr']);
  });

  it('порядок из конфига сохраняется, дубли схлопываются', () => {
    expect(enabledLocalesFrom(['en', 'ru'])).toEqual(['en', 'ru']);
    expect(enabledLocalesFrom(['ru', 'ru', 'en'])).toEqual(['ru', 'en']);
  });

  it('пустой/отсутствующий вход (API недоступен) → fail-open весь whitelist', () => {
    expect(enabledLocalesFrom(undefined)).toEqual([...LOCALES]);
    expect(enabledLocalesFrom(null)).toEqual([...LOCALES]);
    expect(enabledLocalesFrom([])).toEqual([...LOCALES]);
  });

  it('вход без единого валидного кода → fail-open весь whitelist (переключатель не пустеет)', () => {
    expect(enabledLocalesFrom(['de', 'es'])).toEqual([...LOCALES]);
  });

  it('дефолтная локаль всегда попадает в набор, если она в конфиге', () => {
    expect(enabledLocalesFrom(['ru', 'en'])).toContain(DEFAULT_LOCALE);
  });
});

describe('alternatesFor — hreflang строится по переданному enabled-набору', () => {
  it('по умолчанию (без набора) — весь whitelist (обратная совместимость)', () => {
    const alt = alternatesFor('/catalog', 'en');
    expect(Object.keys(alt.languages).sort()).toEqual(['en', 'fr', 'ru']);
    expect(alt.languages.ru).toBe('/catalog');
    expect(alt.languages.en).toBe('/en/catalog');
    expect(alt.languages.fr).toBe('/fr/catalog');
    expect(alt.canonical).toBe('/en/catalog');
  });

  it('выключенный язык НЕ попадает в hreflang', () => {
    const alt = alternatesFor('/catalog', 'en', ['ru', 'en']);
    expect(Object.keys(alt.languages).sort()).toEqual(['en', 'ru']);
    expect(alt.languages.fr).toBeUndefined();
    expect(alt.canonical).toBe('/en/catalog');
  });

  it('только дефолтная локаль → единственный hreflang', () => {
    const alt = alternatesFor('/catalog', 'ru', ['ru']);
    expect(Object.keys(alt.languages)).toEqual(['ru']);
    expect(alt.languages.ru).toBe('/catalog');
    expect(alt.canonical).toBe('/catalog');
  });

  it('canonical корректен, даже если current вне переданного набора', () => {
    // Пограничный случай: пользователь на выключенном языке ДО редиректа layout.
    const alt = alternatesFor('/', 'fr', ['ru', 'en']);
    expect(alt.canonical).toBe('/fr');
    expect(alt.languages.fr).toBeUndefined();
  });
});
