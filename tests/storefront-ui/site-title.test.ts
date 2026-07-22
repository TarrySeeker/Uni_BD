import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Настоящий резолвер Next (не самописная копия) — оракул того, как реально
// схлопнется title витрины в рантайме: строка прогоняется через template
// родительского layout, `{ absolute }` — нет.
import { resolveTitle } from 'next/dist/lib/metadata/resolvers/resolve-title';

import { siteTitle, metaTitle } from '../../storefront/lib/seo';
import type { PublicSettingsDto } from '../../storefront/lib/types';

// ЮНИТ: заголовки страниц берутся ИЗ АДМИНКИ (settings.seo), а не из хардкода.
// На проде <title> главной — длинная SEO-фраза из БД (thread.seo_title), а не имя
// магазина. Витрина обязана уметь то же: владелец меняет title в админке без правки
// кода. titleTemplate — шаблон с '%s' под заголовок страницы (Next-совместимый).
function settings(seo: Partial<PublicSettingsDto['seo']>): PublicSettingsDto {
  return {
    seo: {
      siteName: null,
      siteUrl: null,
      titleTemplate: '%s',
      defaultDescription: null,
      twitterSite: null,
      ...seo,
    },
  } as PublicSettingsDto;
}

const STOREFRONT = resolve(__dirname, '../../storefront');
const source = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

describe('siteTitle — заголовок сайта (главная)', () => {
  it('берёт siteName из админки', () => {
    expect(siteTitle(settings({ siteName: 'Carre-Russe' }))).toBe('Carre-Russe');
  });

  it('SEO-фраза прода целиком помещается в siteName', () => {
    const prod = 'Carré Russe — платки, банданы, шарфы и твилли с принтами русской культуры и традиции';
    expect(siteTitle(settings({ siteName: prod }))).toBe(prod);
  });

  it('нет настроек → пустая строка, а не чужой хардкод', () => {
    expect(siteTitle(null)).toBe('');
    expect(siteTitle(settings({ siteName: null }))).toBe('');
  });
});

describe('metaTitle — серверный заголовок vs собственный', () => {
  it('серверный meta.title отдаётся как absolute (шаблон уже применён на сервере)', () => {
    expect(metaTitle('Твилли микро | Магазин', 'Твилли микро')).toEqual({
      absolute: 'Твилли микро | Магазин',
    });
  });

  it('нет серверного заголовка → собственный заголовок строкой (его прогонит шаблон Next)', () => {
    expect(metaTitle(null, 'Твилли микро')).toBe('Твилли микро');
    expect(metaTitle(undefined, 'Твилли микро')).toBe('Твилли микро');
    expect(metaTitle('   ', 'Твилли микро')).toBe('Твилли микро');
  });

  it('обрезает пробелы у обоих источников', () => {
    expect(metaTitle('  Готовый  ', 'x')).toEqual({ absolute: 'Готовый' });
    expect(metaTitle(null, '  Свой  ')).toBe('Свой');
  });

  it('пусто и там и там → absolute-пустышка, а не голый суффикс шаблона', () => {
    expect(metaTitle(null, '')).toEqual({ absolute: '' });
  });
});

// Ключевой регресс: шаблон с суффиксом. Прогоняем результат metaTitle через НАСТОЯЩИЙ
// resolveTitle Next с template из layout — как это произойдёт в рантайме.
describe('шаблон с суффиксом: двойного применения быть не должно', () => {
  const TEMPLATE = '%s | Магазин';

  it('страница с серверным meta.title — суффикс ровно один раз', () => {
    // Сервер (buildSeoMeta → applyTitleTemplate) уже отдал готовый title.
    const fromServer = 'Твилли микро | Магазин';
    const resolved = resolveTitle(metaTitle(fromServer, 'Твилли микро'), TEMPLATE);
    expect(resolved.absolute).toBe('Твилли микро | Магазин');
  });

  it('страница со своим заголовком (каталог/поиск) — суффикс применяется', () => {
    const resolved = resolveTitle(metaTitle(null, 'Каталог'), TEMPLATE);
    expect(resolved.absolute).toBe('Каталог | Магазин');
  });

  it('простая строка title (как в catalog/search) шаблон не теряет', () => {
    expect(resolveTitle('Каталог', TEMPLATE).absolute).toBe('Каталог | Магазин');
  });

  it('шаблон-тождество "%s" не меняет ни один из вариантов', () => {
    expect(resolveTitle(metaTitle('Твилли микро', 'Твилли микро'), '%s').absolute).toBe(
      'Твилли микро',
    );
    expect(resolveTitle(metaTitle(null, 'Каталог'), '%s').absolute).toBe('Каталог');
  });

  it('шаблон с несколькими %s: сервер уже подставил всё — витрина не подставляет заново', () => {
    const fromServer = 'Твилли микро — Твилли микро';
    const resolved = resolveTitle(metaTitle(fromServer, 'Твилли микро'), '%s — %s');
    expect(resolved.absolute).toBe('Твилли микро — Твилли микро');
  });
});

// Гарантия, что фикс реально применён на страницах, берущих title из meta.* сервера
// (юнит-тест самих generateMetadata недоступен: alias '@' в vitest указывает на корень
// админки, а не на storefront).
describe('страницы с серверным meta.* используют metaTitle', () => {
  const pages = [
    'app/[lang]/product/[slug]/page.tsx',
    'app/[lang]/[slug]/page.tsx',
    'app/[lang]/designers/[slug]/page.tsx',
  ];

  for (const rel of pages) {
    it(`${rel} — title через metaTitle`, () => {
      const code = source(rel);
      expect(code).toMatch(/title:\s*metaTitle\(/);
      expect(code).toMatch(/from '@\/lib\/seo'/);
    });

    it(`${rel} — meta.title не уходит в title сырой строкой`, () => {
      const code = source(rel);
      expect(code).not.toMatch(/title:\s*[\w.]*meta\.(og)?[Tt]itle/);
    });
  }

  it('CMS-страница: og:title тоже не прогоняется шаблоном повторно', () => {
    // openGraph.title в Next резолвится тем же titleTemplate (resolve-opengraph.js).
    const code = source('app/[lang]/[slug]/page.tsx');
    expect(code).toMatch(/openGraph:\s*\{\s*[\s\S]*?title:\s*metaTitle\(/);
  });
});

// Собственные заголовки витрины (каталог/поиск) должны ОСТАТЬСЯ строками — шаблон им нужен.
describe('страницы со своим заголовком продолжают использовать шаблон', () => {
  for (const rel of [
    'app/[lang]/catalog/page.tsx',
    'app/[lang]/catalog/[...slug]/page.tsx',
    'app/[lang]/search/page.tsx',
  ]) {
    it(`${rel} — title остаётся строкой (без absolute)`, () => {
      const code = source(rel);
      expect(code).not.toMatch(/title:\s*\{\s*absolute/);
      expect(code).not.toMatch(/title:\s*metaTitle\(/);
    });
  }
});

// pageTitle() удалён: мёртвый код с расходящейся семантикой (replace первого '%s'
// против replaceAll у Next). Правило подстановки на витрине должно быть ровно одно —
// внутри Next; см. storefront/lib/seo.ts.
describe('нет третьей реализации правила подстановки', () => {
  it('storefront/lib/seo.ts не подставляет %s сам', () => {
    const code = source('lib/seo.ts');
    expect(code).not.toMatch(/\.replace(All)?\(\s*['"]%s['"]/);
    expect(code).not.toMatch(/export function pageTitle/);
  });
});
