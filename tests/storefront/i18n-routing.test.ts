import { describe, it, expect } from 'vitest';

/**
 * Тесты РОУТИНГА локали витрины (storefront/lib/i18n.ts). Импорт относительным
 * путём: storefront — отдельное Next-приложение со своим алиасом @, а i18n.ts —
 * standalone-модуль без @/-импортов (чистые функции), поэтому тянем напрямую.
 *
 * Схема (как на старом carrerusse.com): ru — КОРЕНЬ без префикса; en → /en; fr → /fr.
 * Проверяем: валидацию/нормализацию локали, построение локализованных ссылок,
 * разбор входящего пути, перестроение под другую локаль (переключатель) и
 * hreflang-альтернативы.
 */

import {
  LOCALES,
  DEFAULT_LOCALE,
  isLocale,
  toLocale,
  localePrefix,
  localizedHref,
  stripLocale,
  switchLocalePath,
  alternatesFor,
} from '../../storefront/lib/i18n';
import { getDictionary, fillTemplate } from '../../storefront/lib/dictionaries';

describe('i18n — локали и валидация', () => {
  it('поддерживает ровно три локали, ru — дефолт', () => {
    expect([...LOCALES]).toEqual(['ru', 'en', 'fr']);
    expect(DEFAULT_LOCALE).toBe('ru');
  });

  it('isLocale отличает валидные коды от мусора', () => {
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale('RU')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('toLocale нормализует неизвестное значение в ru (фолбэк)', () => {
    expect(toLocale('en')).toBe('en');
    expect(toLocale('fr')).toBe('fr');
    expect(toLocale('xx')).toBe('ru');
    expect(toLocale(undefined)).toBe('ru');
  });
});

describe('i18n — префиксы и построение ссылок', () => {
  it('localePrefix: ru — пусто (корень), en/fr — с префиксом', () => {
    expect(localePrefix('ru')).toBe('');
    expect(localePrefix('en')).toBe('/en');
    expect(localePrefix('fr')).toBe('/fr');
  });

  it('localizedHref навешивает префикс локали (ru — без)', () => {
    expect(localizedHref('/catalog', 'ru')).toBe('/catalog');
    expect(localizedHref('/catalog', 'en')).toBe('/en/catalog');
    expect(localizedHref('/catalog', 'fr')).toBe('/fr/catalog');
    // Корень '/' → '/en' (без хвостового слэша); ru → '/'.
    expect(localizedHref('/', 'ru')).toBe('/');
    expect(localizedHref('/', 'en')).toBe('/en');
    expect(localizedHref('/', 'fr')).toBe('/fr');
  });

  it('localizedHref НЕ трогает внешние/специальные ссылки', () => {
    expect(localizedHref('https://example.com', 'en')).toBe('https://example.com');
    expect(localizedHref('http://example.com', 'fr')).toBe('http://example.com');
    expect(localizedHref('//cdn.example.com/x', 'en')).toBe('//cdn.example.com/x');
    expect(localizedHref('mailto:a@b.com', 'en')).toBe('mailto:a@b.com');
    expect(localizedHref('tel:+70000000000', 'fr')).toBe('tel:+70000000000');
    expect(localizedHref('', 'en')).toBe('');
  });

  it('localizedHref сохраняет query-строку', () => {
    expect(localizedHref('/catalog?sort=asc', 'en')).toBe('/en/catalog?sort=asc');
    expect(localizedHref('/catalog?page=2&sort=desc', 'fr')).toBe(
      '/fr/catalog?page=2&sort=desc',
    );
  });
});

describe('i18n — разбор входящего пути (stripLocale)', () => {
  it('снимает префикс en/fr, ru-путь остаётся голым', () => {
    expect(stripLocale('/en/catalog')).toEqual({ locale: 'en', rest: '/catalog' });
    expect(stripLocale('/fr/product/x')).toEqual({ locale: 'fr', rest: '/product/x' });
    expect(stripLocale('/catalog')).toEqual({ locale: 'ru', rest: '/catalog' });
  });

  it('корень каждой локали → rest === "/"', () => {
    expect(stripLocale('/')).toEqual({ locale: 'ru', rest: '/' });
    expect(stripLocale('/en')).toEqual({ locale: 'en', rest: '/' });
    expect(stripLocale('/fr')).toEqual({ locale: 'fr', rest: '/' });
  });

  it('сегмент "ru" в пути НЕ считается префиксом (ru живёт на корне)', () => {
    // /ru/... не должен появляться в адресной строке; трактуем как обычный путь ru.
    expect(stripLocale('/ru/catalog')).toEqual({ locale: 'ru', rest: '/ru/catalog' });
  });
});

describe('i18n — переключатель языка (switchLocalePath)', () => {
  it('перестраивает текущий путь под целевую локаль', () => {
    expect(switchLocalePath('/en/catalog', 'fr')).toBe('/fr/catalog');
    expect(switchLocalePath('/en/catalog', 'ru')).toBe('/catalog');
    expect(switchLocalePath('/catalog', 'en')).toBe('/en/catalog');
    expect(switchLocalePath('/catalog', 'ru')).toBe('/catalog');
  });

  it('корень переключается между локалями корректно', () => {
    expect(switchLocalePath('/', 'en')).toBe('/en');
    expect(switchLocalePath('/en', 'fr')).toBe('/fr');
    expect(switchLocalePath('/fr', 'ru')).toBe('/');
  });

  it('переключение туда-обратно идемпотентно для каждой локали', () => {
    for (const l of LOCALES) {
      const there = switchLocalePath('/catalog/twilly', l);
      const back = switchLocalePath(there, 'ru');
      expect(back).toBe('/catalog/twilly');
    }
  });
});

describe('i18n — hreflang-альтернативы (alternatesFor)', () => {
  it('даёт languages для всех трёх локалей и canonical на текущую', () => {
    const alt = alternatesFor('/catalog', 'en');
    expect(alt.languages).toEqual({
      ru: '/catalog',
      en: '/en/catalog',
      fr: '/fr/catalog',
    });
    expect(alt.canonical).toBe('/en/catalog');
  });

  it('для корня canonical и languages корректны', () => {
    const alt = alternatesFor('/', 'ru');
    expect(alt.languages).toEqual({ ru: '/', en: '/en', fr: '/fr' });
    expect(alt.canonical).toBe('/');
  });
});

describe('dictionaries — сериализуемость и шаблоны', () => {
  it('словарь каждой локали НЕ содержит функций (сериализуем server→client)', () => {
    const hasFunction = (obj: unknown): boolean => {
      if (typeof obj === 'function') return true;
      if (obj && typeof obj === 'object') {
        return Object.values(obj).some(hasFunction);
      }
      return false;
    };
    for (const l of LOCALES) {
      expect(hasFunction(getDictionary(l))).toBe(false);
    }
  });

  it('getDictionary даёт словарь запрошенной локали, неизвестная → ru', () => {
    expect(getDictionary('en').common.catalog).toBe('Catalog');
    expect(getDictionary('fr').common.catalog).toBe('Catalogue');
    expect(getDictionary('ru').common.catalog).toBe('Каталог');
    // toLocale страхует вход; getDictionary дополнительно фолбэчит на ru.
    expect(getDictionary(toLocale('zz')).common.catalog).toBe('Каталог');
  });

  it('fillTemplate подставляет плейсхолдеры {code}/{q}/{n}', () => {
    expect(fillTemplate('Работ: {n}', { n: 5 })).toBe('Работ: 5');
    expect(fillTemplate(getDictionary('en').search.resultsFor, { q: 'silk' })).toBe(
      'Search: “silk”',
    );
    expect(fillTemplate(getDictionary('ru').header.currencyAria, { code: 'EUR' })).toBe(
      'Показывать цены в EUR',
    );
    // Неизвестный плейсхолдер остаётся как есть.
    expect(fillTemplate('a {x} b', { y: 1 })).toBe('a {x} b');
  });
});
