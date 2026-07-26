import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// Настоящий резолвер Next — оракул того, во что схлопнется title витрины.
import { resolveTitle } from 'next/dist/lib/metadata/resolvers/resolve-title';

import {
  siteTitle,
  siteTitleTemplate,
  siteDescription,
  rootTitle,
  metaTitle,
} from '../../storefront/lib/seo';
import type { PublicSettingsDto } from '../../storefront/lib/types';

/**
 * ДЕФЕКТ (латентный 500 на ВСЁМ живом сайте): витрина обращалась к секциям
 * настроек «на один уровень» — `settings?.seo.titleTemplate`, `settings?.home.hero`,
 * `settings?.currency.code`, `settings?.contacts.socials`, `settings?.branding.shopName`.
 * `?.` защищал только от `settings === null`. Если ответ `/settings` придёт БЕЗ
 * секции (реальный сценарий version skew: админка и витрина выкатываются разными
 * образами, у старой админки поля ещё нет), то `settings.seo` === undefined и
 * `.titleTemplate` бросает TypeError. В `generateMetadata` корневого layout это
 * 500 на КАЖДОЙ странице магазина, а не деградация одного блока.
 *
 * Правило: доступ к настройкам обязан переживать отсутствие секции.
 *  - SEO-заголовки — через чистые аксессоры lib/seo.ts (одно место знает форму);
 *  - остальные секции — глубокий optional chaining (`settings?.home?.hero`),
 *    сторожится guard-ом ниже по исходникам.
 *
 * ВТОРОЙ СЛОЙ ТОГО ЖЕ ДЕФЕКТА: секция может ПРИЙТИ, а поле в ней быть пустым.
 * `seo.siteName` по контракту nullable (`string | null`), и это ШТАТНОЕ состояние
 * провода: сервер собирает его как `seo.site_name ?? branding.shopName-override ??
 * env.SHOP_NAME` (lib/config/settings.ts) — владелец SEO-блок не заполнял, значит
 * null, хотя имя магазина в настройках ЕСТЬ (`branding.shopName` — не-nullable,
 * с дефолтом). Поэтому пустая строка / пробелы / null / undefined / НЕ-строка
 * обязаны вести себя одинаково («значения нет») во ВСЕХ аксессорах, а имя сайта —
 * падать на `branding.shopName`, иначе <title> схлопывается в пустой.
 */

/** Полноценные настройки (happy path). */
function full(seo: Partial<PublicSettingsDto['seo']> = {}): PublicSettingsDto {
  return {
    seo: {
      siteName: 'Carre-Russe',
      siteUrl: null,
      titleTemplate: '%s',
      defaultDescription: null,
      twitterSite: null,
      ...seo,
    },
  } as PublicSettingsDto;
}

const SHOP = 'Мой Магазин';

/**
 * Настройки с секцией branding — источник имени магазина, когда seo пуст.
 * shopName ОБЯЗАТЕЛЕН (без дефолта): иначе кейс «shopName = undefined» молча
 * подставил бы дефолт и проверял бы не то, что заявлено.
 */
function withBranding(
  seo: Partial<Record<keyof PublicSettingsDto['seo'], unknown>>,
  shopName: unknown,
): PublicSettingsDto {
  return { ...full(), seo: { ...full().seo, ...seo }, branding: { shopName } } as PublicSettingsDto;
}

/** Ответ старой/новой админки БЕЗ секции seo — ровно тот version skew. */
const NO_SEO = { branding: { shopName: 'Carre-Russe' } } as unknown as PublicSettingsDto;
const EMPTY = {} as PublicSettingsDto;
/** Секция пришла мусором (не объектом) — API/прокси отдал что-то не то. */
const SEO_NOT_OBJECT = { seo: 'oops' } as unknown as PublicSettingsDto;
/** Мусор в ОБЕИХ секциях, откуда берётся имя сайта. */
const SECTIONS_NOT_OBJECTS = { seo: 'oops', branding: 42 } as unknown as PublicSettingsDto;
/** Не объект вовсе (прокси отдал строку/число вместо DTO). */
const SETTINGS_NOT_OBJECT = 'oops' as unknown as PublicSettingsDto;

describe('аксессоры настроек не бросают при отсутствующей секции seo', () => {
  // Третий элемент — ожидаемое имя сайта: при отсутствующем seo оно приезжает из
  // branding.shopName, и только когда нет ни того, ни другого — пустая строка.
  const cases: [string, PublicSettingsDto | null, string][] = [
    ['settings без seo (имя сайта из branding.shopName)', NO_SEO, 'Carre-Russe'],
    ['пустой объект', EMPTY, ''],
    ['settings = null', null, ''],
    ['seo не объект', SEO_NOT_OBJECT, ''],
    ['seo и branding не объекты', SECTIONS_NOT_OBJECTS, ''],
    ['settings не объект вовсе', SETTINGS_NOT_OBJECT, ''],
  ];

  for (const [label, s, expectedSiteTitle] of cases) {
    it(`siteTitle — ${label}`, () => {
      expect(() => siteTitle(s)).not.toThrow();
      expect(siteTitle(s)).toBe(expectedSiteTitle);
    });

    it(`siteTitleTemplate — ${label} → тождественный шаблон '%s'`, () => {
      expect(() => siteTitleTemplate(s)).not.toThrow();
      expect(siteTitleTemplate(s)).toBe('%s');
    });

    it(`siteDescription — ${label} → undefined`, () => {
      expect(() => siteDescription(s)).not.toThrow();
      expect(siteDescription(s)).toBeUndefined();
    });

    it(`rootTitle — ${label} (метаданные корневого layout собираются без исключения)`, () => {
      expect(() => rootTitle(s)).not.toThrow();
      // Ровно то, что попадёт в Metadata.title корневого layout.
      expect(rootTitle(s)).toEqual({ default: expectedSiteTitle, template: '%s' });
    });

    it(`metaTitle — ${label} (третий аргумент-настройки не роняет страницу)`, () => {
      expect(() => metaTitle(null, 'Каталог', s)).not.toThrow();
      expect(metaTitle(null, 'Каталог', s)).toBe('Каталог');
      // Ветка «оба источника пусты» — фолбэк на имя сайта, без исключения.
      expect(() => metaTitle(null, null, s)).not.toThrow();
      expect(metaTitle(null, null, s)).toEqual({ absolute: expectedSiteTitle });
    });
  }
});

describe('пустое/пробельное/чужого типа значение поля = «значения нет» (все аксессоры)', () => {
  // Ровно те значения, которые прилетают с провода вместо строки. `42` — version
  // skew сменил тип поля: `siteName?.trim()` на числе бросил бы TypeError,
  // то есть снова 500 в generateMetadata.
  const BLANK: [string, unknown][] = [
    ['пустая строка', ''],
    ['пробелы', '   '],
    ['null', null],
    ['undefined', undefined],
    ['не строка', 42],
  ];

  for (const [label, value] of BLANK) {
    it(`siteName = ${label} → имя сайта из branding.shopName, а не пустота`, () => {
      const s = withBranding({ siteName: value }, SHOP);
      expect(siteTitle(s)).toBe(SHOP);
      expect(rootTitle(s)).toEqual({ default: SHOP, template: '%s' });
      // Главное следствие: <title> страницы без своих источников НЕ пустой.
      expect(metaTitle(null, null, s)).toEqual({ absolute: SHOP });
    });

    it(`siteName = ${label} и shopName = ${label} → пустая строка без исключения`, () => {
      const s = withBranding({ siteName: value }, value);
      expect(() => siteTitle(s)).not.toThrow();
      expect(siteTitle(s)).toBe('');
      expect(() => metaTitle(null, null, s)).not.toThrow();
    });

    it(`titleTemplate = ${label} → тождественный '%s'`, () => {
      expect(siteTitleTemplate(withBranding({ titleTemplate: value }, SHOP))).toBe('%s');
    });

    it(`defaultDescription = ${label} → undefined`, () => {
      expect(siteDescription(withBranding({ defaultDescription: value }, SHOP))).toBeUndefined();
    });
  }

  it('осмысленные значения обрезаются по краям (пробелы в БД — не часть заголовка)', () => {
    expect(siteTitle(withBranding({ siteName: '  Carré Russe  ' }, SHOP))).toBe('Carré Russe');
    expect(siteTitle(withBranding({ siteName: null }, '  Мой Магазин  '))).toBe('Мой Магазин');
    expect(siteTitleTemplate(withBranding({ titleTemplate: '  %s — Carré Russe  ' }, SHOP))).toBe(
      '%s — Carré Russe',
    );
  });
});

describe('аксессоры настроек на здоровом ответе', () => {
  it('siteTitle — siteName из админки', () => {
    expect(siteTitle(full({ siteName: 'Carre-Russe' }))).toBe('Carre-Russe');
  });

  it('siteTitleTemplate — шаблон владельца отдаётся как есть', () => {
    expect(siteTitleTemplate(full({ titleTemplate: '%s — Carré Russe' }))).toBe(
      '%s — Carré Russe',
    );
  });

  it('siteTitleTemplate — шаблон без %s не применяем (иначе он затрёт заголовок)', () => {
    expect(siteTitleTemplate(full({ titleTemplate: 'Carré Russe' }))).toBe('%s');
    expect(siteTitleTemplate(full({ titleTemplate: '' }))).toBe('%s');
  });

  it('siteDescription — пустое/пробельное описание не отдаём', () => {
    expect(siteDescription(full({ defaultDescription: '  Платки  ' }))).toBe('Платки');
    expect(siteDescription(full({ defaultDescription: '   ' }))).toBeUndefined();
    expect(siteDescription(full({ defaultDescription: null }))).toBeUndefined();
  });

  it('rootTitle — default = имя сайта, template = шаблон владельца', () => {
    expect(rootTitle(full({ siteName: 'Carre-Russe', titleTemplate: '%s | Carre' }))).toEqual({
      default: 'Carre-Russe',
      template: '%s | Carre',
    });
  });

  it('rootTitle прогоняется настоящим resolveTitle Next без исключения', () => {
    const resolved = resolveTitle(rootTitle(NO_SEO), null);
    // Секции seo нет — имя сайта подхватилось из branding.shopName, <title> живой.
    expect(resolved.absolute).toBe('Carre-Russe');
    expect(resolved.template).toBe('%s');
  });

  it('seo.siteName приоритетнее branding.shopName (владелец задал SEO-имя явно)', () => {
    const s = withBranding({ siteName: 'SEO-имя' }, 'Имя из брендинга');
    expect(siteTitle(s)).toBe('SEO-имя');
  });
});

// GUARD по исходникам: ни одного «однослойного» обращения к секции настроек.
// Комментарии пишут `settings.home.hero` (без `?.`) — под шаблон не попадают.
//
// ОХВАТ — ВСЯ витрина, а не app/ + lib/: `middleware.ts` лежит в корне и исполняется
// на КАЖДОМ запросе (падение = 500 всего сайта, ещё до рендера). Сейчас настройки он
// не читает, но guard обязан поймать это, если завтра начнёт (напр. редирект по
// settings.i18n). Исключаем только чужое/сгенерированное.
describe('GUARD: в витрине нет однослойных обращений settings?.<секция>.<поле>', () => {
  const STOREFRONT = resolve(__dirname, '../../storefront');
  // Любой идентификатор настроек (settings / publicSettings / shopSettings…),
  // у которого `?.` стоит ТОЛЬКО на первом звене.
  const SHALLOW = /\b[\w$]*[sS]ettings\?\.[A-Za-z_$][\w$]*\.[A-Za-z_$]/g;
  const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', 'out', '.turbo']);
  // Генерируется Next и правкам не подлежит (по правилу проекта не трогаем).
  const SKIP_FILES = new Set(['next-env.d.ts']);

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.tsx?$/.test(p)) acc.push(p);
    }
    return acc;
  }

  const files = walk(STOREFRONT);
  const rels = files.map((f) => relative(STOREFRONT, f).split(sep).join('/'));

  it('файлы витрины найдены (guard не самообманывается пустым списком)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('охват — ВСЯ витрина, включая .ts вне app/ и lib/ (middleware исполняется на каждом запросе)', () => {
    expect(rels).toContain('middleware.ts');
    expect(rels.some((r) => r.startsWith('app/'))).toBe(true);
    expect(rels.some((r) => r.startsWith('lib/'))).toBe(true);
    // Каждый .ts/.tsx витрины (кроме сгенерированного) обязан быть в охвате.
    expect(rels).not.toContain('next-env.d.ts');
  });

  it('шаблон guard-а рабочий (не превратился в вечнозелёный no-op)', () => {
    expect('const t = settings?.seo.titleTemplate;'.match(SHALLOW)).not.toBeNull();
    expect('const t = publicSettings?.home.hero;'.match(SHALLOW)).not.toBeNull();
    expect('const t = settings?.seo?.titleTemplate;'.match(SHALLOW)).toBeNull();
    expect('const t = seoOf(settings).siteName;'.match(SHALLOW)).toBeNull();
  });

  it('ни один файл витрины не читает секцию настроек без ?.', () => {
    const offenders = files.flatMap((f) => {
      const hits = readFileSync(f, 'utf8').match(SHALLOW) ?? [];
      return hits.map((h) => `${relative(STOREFRONT, f)}: ${h}`);
    });
    expect(offenders).toEqual([]);
  });

  it('корневой layout берёт title/description только через аксессоры lib/seo', () => {
    const code = readFileSync(join(STOREFRONT, 'app/[lang]/layout.tsx'), 'utf8');
    expect(code).toMatch(/title:\s*rootTitle\(settings\)/);
    expect(code).toMatch(/description:\s*siteDescription\(settings\)/);
    // Ни прямого чтения секции seo, ни своей сборки шаблона (упоминание
    // titleTemplate в поясняющем комментарии — можно, обращение к полю — нет).
    expect(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')).not.toMatch(/settings[?!]?\.seo/);
    expect(code).not.toMatch(/includes\(\s*['"]%s['"]\s*\)/);
  });
});
