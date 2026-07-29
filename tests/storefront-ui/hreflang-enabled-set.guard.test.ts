import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { alternatesFor } from '../../storefront/lib/i18n';

// GUARD-тесты hreflang по enabled-набору (волна 5). Дефект: generateMetadata
// каждой SEO-страницы звал alternatesFor(path, locale) БЕЗ 3-го аргумента, поэтому
// в hreflang всегда попадал весь whitelist ['ru','en','fr'] — даже выключенные в
// админке языки. Юнит i18n-enabled-locales.test.ts проверяет саму функцию
// alternatesFor с усечённым набором; здесь сторожим, что РОУТЫ реально прокидывают
// enabled-набор третьим аргументом (иначе откат к 2-арг вызову прошёл бы мимо
// юнитов незаметно, а выключенный язык вернулся бы в hreflang на публичном сайте).
// alternates-модули — Next-компоненты на алиасе '@/...'; берём их исходником.

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

// Шесть SEO-страниц, эмитящих hreflang (home не в списке — она hreflang не отдаёт).
const PAGES = [
  'app/[lang]/catalog/page.tsx',
  'app/[lang]/catalog/[...slug]/page.tsx',
  'app/[lang]/product/[slug]/page.tsx',
  'app/[lang]/designers/[slug]/page.tsx',
  'app/[lang]/[slug]/page.tsx',
  'app/[lang]/search/page.tsx',
] as const;

describe('generateMetadata SEO-страниц прокидывает enabled-набор в alternatesFor', () => {
  for (const rel of PAGES) {
    it(`${rel}: alternatesFor зовётся с 3-м аргументом (enabled-набор), не 2-арг`, () => {
      const s = src(rel);
      // Все вызовы alternatesFor(...) в файле. Каждый обязан иметь ≥3 аргумента.
      const calls = s.match(/alternatesFor\([^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // Считаем запятые верхнего уровня внутри скобок: аргументы path, current,
        // enabledLocales → минимум две запятые. Внутри аргументов вложенных скобок
        // с запятыми у нас нет (path — строковый литерал/идентификатор).
        const inner = call.slice('alternatesFor('.length, -1);
        const argCount = inner.split(',').length;
        expect(argCount).toBeGreaterThanOrEqual(3);
      }
      // enabled-набор считается из настроек магазина ровно тем же helper'ом, что и
      // гейт языков в layout (fail-open при отсутствии настроек).
      expect(s).toContain('enabledLocalesFrom');
      expect(s).toMatch(/getSettings/);
    });
  }
});

describe('CMS-страница: явный canonical оставлен нетронутым', () => {
  const source = () => src('app/[lang]/[slug]/page.tsx');

  it('ветка meta.canonical по-прежнему возвращает { canonical } без alternatesFor', () => {
    const s = source();
    // Тернарник: meta.canonical ? { canonical: ... } : alternatesFor(..., enabledLocales)
    expect(s).toMatch(/meta\.canonical\s*\?/);
    expect(s).toMatch(/\{\s*canonical:\s*meta\.canonical\s*\}/);
    // enabled-набор прокинут именно в ELSE-ветке alternatesFor (4-й аргумент —
    // абсолютная база URL, добавлена аудитом №34; см. hreflang-absolute-url.test.ts).
    expect(s).toMatch(/alternatesFor\(`\/\$\{slug\}`,\s*locale,\s*enabledLocales,\s*urlBase\)/);
  });
});

describe('alternatesFor с усечённым набором эмитит только его ключи (интеграция)', () => {
  it('набор [ru, en] → в languages нет fr', () => {
    const alt = alternatesFor('/catalog', 'en', ['ru', 'en']);
    expect(Object.keys(alt.languages).sort()).toEqual(['en', 'ru']);
    expect(alt.languages.fr).toBeUndefined();
  });
});
