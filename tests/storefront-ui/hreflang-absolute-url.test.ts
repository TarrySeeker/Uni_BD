import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Аудит №34 (major) — hreflang относительными URL, на главной его нет.
 *
 * ДЕФЕКТ. `alternatesFor` возвращала ОТНОСИТЕЛЬНЫЕ пути (`/en/catalog`), а
 * `metadataBase` в витрине не задавался нигде (единственное упоминание было в
 * комментарии). Next в таком случае подставляет `http://localhost:3000` и печатает
 * warning; поисковики связку `hreflang` с относительными/localhost-URL игнорируют.
 * Плюс на ГЛАВНОЙ (`app/[lang]/page.tsx`) `alternates` содержал только `canonical`,
 * то есть hreflang не было вовсе — при том, что главная у мультиязычного магазина
 * и есть самая важная страница для языкового таргетинга.
 *
 * РЕШЕНИЕ. Абсолютный базовый URL магазина берём из настроек (`seo.siteUrl`,
 * админка → Настройки → SEO) — тот же источник, что у sitemap/robots/canonical
 * сервера и у return-url платежей. Хардкода домена нет (мультитенантность): нет
 * настройки → остаёмся на относительных путях (прежнее поведение, не хуже).
 */

import { LOCALES, alternatesFor, absoluteUrlBase } from '../../storefront/lib/i18n';

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

const settingsWith = (siteUrl: string | null) =>
  ({ seo: { siteUrl } }) as unknown as Parameters<typeof absoluteUrlBase>[0];

describe('absoluteUrlBase — база абсолютных URL из настроек магазина', () => {
  it('берёт seo.siteUrl из настроек (без хардкода домена)', () => {
    expect(absoluteUrlBase(settingsWith('https://shop.example'))).toBe('https://shop.example');
  });

  it('срезает хвостовые слэши (иначе получится //en/catalog)', () => {
    expect(absoluteUrlBase(settingsWith('https://shop.example/'))).toBe('https://shop.example');
    expect(absoluteUrlBase(settingsWith('https://shop.example///'))).toBe('https://shop.example');
  });

  it('нет настройки / пустая / пробелы / не строка → null (остаёмся на относительных)', () => {
    expect(absoluteUrlBase(settingsWith(null))).toBeNull();
    expect(absoluteUrlBase(settingsWith(''))).toBeNull();
    expect(absoluteUrlBase(settingsWith('   '))).toBeNull();
    expect(absoluteUrlBase(undefined)).toBeNull();
    expect(absoluteUrlBase(null)).toBeNull();
    expect(absoluteUrlBase({} as never)).toBeNull();
    expect(absoluteUrlBase({ seo: { siteUrl: 42 } } as never)).toBeNull();
  });

  it('не-http(s) схема отвергается (данные БД могли протухнуть) — anti-XSS/anti-open-redirect', () => {
    expect(absoluteUrlBase(settingsWith('javascript:alert(1)'))).toBeNull();
    expect(absoluteUrlBase(settingsWith('ftp://shop.example'))).toBeNull();
    expect(absoluteUrlBase(settingsWith('//shop.example'))).toBeNull();
  });
});

describe('alternatesFor — АБСОЛЮТНЫЕ hreflang при заданной базе', () => {
  it('languages и canonical становятся абсолютными URL', () => {
    const alt = alternatesFor('/catalog', 'en', LOCALES, 'https://shop.example');
    expect(alt.languages).toEqual({
      ru: 'https://shop.example/catalog',
      en: 'https://shop.example/en/catalog',
      fr: 'https://shop.example/fr/catalog',
    });
    expect(alt.canonical).toBe('https://shop.example/en/catalog');
  });

  it('корень: ru — база без хвостового слэша не теряет "/" ', () => {
    const alt = alternatesFor('/', 'ru', LOCALES, 'https://shop.example');
    expect(alt.languages).toEqual({
      ru: 'https://shop.example/',
      en: 'https://shop.example/en',
      fr: 'https://shop.example/fr',
    });
    expect(alt.canonical).toBe('https://shop.example/');
  });

  it('без базы — прежние ОТНОСИТЕЛЬНЫЕ пути (обратная совместимость)', () => {
    const alt = alternatesFor('/catalog', 'en');
    expect(alt.languages).toEqual({
      ru: '/catalog',
      en: '/en/catalog',
      fr: '/fr/catalog',
    });
    expect(alt.canonical).toBe('/en/catalog');
  });

  it('null-база эквивалентна отсутствию базы', () => {
    const alt = alternatesFor('/catalog', 'fr', ['ru', 'fr'], null);
    expect(alt.languages).toEqual({ ru: '/catalog', fr: '/fr/catalog' });
  });

  it('усечённый enabled-набор по-прежнему уважается и в абсолютном режиме', () => {
    const alt = alternatesFor('/catalog', 'en', ['ru', 'en'], 'https://shop.example');
    expect(Object.keys(alt.languages).sort()).toEqual(['en', 'ru']);
    expect(alt.languages.fr).toBeUndefined();
  });

  it('база с путём-подкаталогом не ломает склейку', () => {
    const alt = alternatesFor('/catalog', 'ru', ['ru'], 'https://example.com/shop');
    expect(alt.languages.ru).toBe('https://example.com/shop/catalog');
  });
});

describe('GUARD — hreflang-страницы прокидывают базу, главная эмитит languages', () => {
  // Шесть SEO-страниц, эмитящих hreflang, + ГЛАВНАЯ (раньше без languages вовсе).
  const PAGES = [
    'app/[lang]/catalog/page.tsx',
    'app/[lang]/catalog/[...slug]/page.tsx',
    'app/[lang]/product/[slug]/page.tsx',
    'app/[lang]/designers/[slug]/page.tsx',
    'app/[lang]/[slug]/page.tsx',
    'app/[lang]/search/page.tsx',
    'app/[lang]/page.tsx',
  ] as const;

  for (const rel of PAGES) {
    it(`${rel}: alternatesFor зовётся с 4-м аргументом (абсолютная база)`, () => {
      const s = src(rel);
      const calls = s.match(/alternatesFor\([^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const inner = call.slice('alternatesFor('.length, -1);
        expect(inner.split(',').length).toBeGreaterThanOrEqual(4);
      }
      expect(s).toContain('absoluteUrlBase');
    });
  }

  it('главная (app/[lang]/page.tsx) отдаёт hreflang, а не только canonical', () => {
    const s = src('app/[lang]/page.tsx');
    expect(s).toContain('alternatesFor');
    expect(s).toContain('enabledLocalesFrom');
    // Прежний «только canonical» из localePrefix — убран.
    expect(s).not.toMatch(/alternates:\s*\{\s*canonical:\s*localePrefix\(locale\)/);
  });

  it('база нигде не захардкожена доменом конкретного магазина (мультитенантность)', () => {
    for (const rel of PAGES) {
      expect(src(rel)).not.toMatch(/https?:\/\/[a-z0-9-]+\.(website|com|ru)/i);
    }
    expect(src('lib/i18n.ts')).not.toMatch(/https?:\/\/[a-z0-9-]+\.(website|com|ru)/i);
  });
});
