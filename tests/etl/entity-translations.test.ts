import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BRAND_TR_FIELDS,
  CATEGORY_TR_FIELDS,
  CMS_PAGE_TR_FIELDS,
  DESIGNER_TR_FIELDS,
  PRODUCT_TR_FIELDS,
} from '@/lib/i18n/fields';
// ETL-загрузчик (.mjs): проверяем ЧИСТЫЕ функции. Импорт main() не запускает —
// он под guard invokedDirectly (как в scripts/load-product-colors.mjs).
import {
  DEFAULT_OVERLAY_LOCALES,
  ENTITY_TARGETS,
  FIELDS_SOURCE_PATH,
  countAcceptedFields,
  diffTranslations,
  formatDiff,
  isSourceFullyRejected,
  loadFieldWhitelist,
  mergeTranslations,
  parseArgs,
  parseFieldWhitelists,
  parseSource,
  readFieldWhitelists,
  resolveEntity,
  resolveOverlayLocales,
} from '../../scripts/load-entity-translations.mjs';

/**
 * scripts/load-entity-translations.mjs — универсальный ETL-загрузчик оверлея
 * translations для любой сущности платформы (мультитенантно: сущность + файл
 * данных приходят аргументами, whitelist полей берётся из lib/i18n/fields.ts).
 *
 * Здесь — только ЧИСТЫЕ функции (БД не нужна):
 *   (а) единый источник правды полей — парсинг lib/i18n/fields.ts;
 *   (б) карта сущность→таблица;
 *   (в) СЛИЯНИЕ оверлея (главное требование: дополнять, а не заменять);
 *   (г) diff для --dry-run и идемпотентность.
 */

const CATEGORIES = ['en', 'fr'];

// =============================================================================
// (а) Единый источник правды: whitelist читается из lib/i18n/fields.ts.
// =============================================================================
describe('load-entity-translations — whitelist из lib/i18n/fields.ts', () => {
  it('парсит `export const X = [...] as const` в карту имя→поля', () => {
    const parsed = parseFieldWhitelists(
      [
        "export const FOO_TR_FIELDS = ['name', 'description'] as const;",
        'export const BAR_TR_FIELDS = [',
        "  'title',",
        "  'seoTitle',",
        '] as const;',
      ].join('\n'),
    );
    expect(parsed.FOO_TR_FIELDS).toEqual(['name', 'description']);
    expect(parsed.BAR_TR_FIELDS).toEqual(['title', 'seoTitle']);
  });

  it('игнорирует не-массивные экспорты (CMS_SECTION_TR_FIELDS — Record)', () => {
    const parsed = parseFieldWhitelists(
      "export const CMS_SECTION_TR_FIELDS: Record<string, readonly string[]> = {\n" +
        "  hero: ['title'],\n};\n",
    );
    expect(parsed.CMS_SECTION_TR_FIELDS).toBeUndefined();
  });

  it('ПАРИТЕТ с настоящими экспортами fields.ts (защита от рассинхрона)', () => {
    const parsed = readFieldWhitelists();
    expect(parsed.CATEGORY_TR_FIELDS).toEqual([...CATEGORY_TR_FIELDS]);
    expect(parsed.PRODUCT_TR_FIELDS).toEqual([...PRODUCT_TR_FIELDS]);
    expect(parsed.DESIGNER_TR_FIELDS).toEqual([...DESIGNER_TR_FIELDS]);
    expect(parsed.BRAND_TR_FIELDS).toEqual([...BRAND_TR_FIELDS]);
    expect(parsed.CMS_PAGE_TR_FIELDS).toEqual([...CMS_PAGE_TR_FIELDS]);
  });

  it('FIELDS_SOURCE_PATH указывает на существующий lib/i18n/fields.ts', () => {
    expect(readFileSync(FIELDS_SOURCE_PATH, 'utf8')).toContain('CATEGORY_TR_FIELDS');
  });

  it('loadFieldWhitelist бросает на неизвестной константе (а не отдаёт пустой список)', () => {
    expect(() => loadFieldWhitelist('NOPE_TR_FIELDS', 'export const X = [] as const;')).toThrow(
      /NOPE_TR_FIELDS/,
    );
  });
});

// =============================================================================
// (б) Карта сущность→таблица (единственное место расширения).
// =============================================================================
describe('load-entity-translations — resolveEntity', () => {
  it('поддерживает все пять сущностей и отдаёт таблицу + константу полей', () => {
    expect(resolveEntity('categories')).toMatchObject({
      table: 'categories',
      fieldsConst: 'CATEGORY_TR_FIELDS',
    });
    expect(resolveEntity('products').table).toBe('products');
    expect(resolveEntity('designers').table).toBe('designers');
    expect(resolveEntity('brands').table).toBe('brands');
    expect(resolveEntity('cms_pages')).toMatchObject({
      table: 'cms_pages',
      fieldsConst: 'CMS_PAGE_TR_FIELDS',
    });
  });

  it('каждая сущность из карты ссылается на существующую константу fields.ts', () => {
    const parsed = readFieldWhitelists();
    for (const target of Object.values(ENTITY_TARGETS) as { fieldsConst: string }[]) {
      expect(Array.isArray(parsed[target.fieldsConst])).toBe(true);
    }
  });

  it('неизвестная сущность → ошибка со списком доступных', () => {
    expect(() => resolveEntity('orders')).toThrow(/categories/);
    expect(() => resolveEntity('')).toThrow();
  });
});

// =============================================================================
// (в) СЛИЯНИЕ, А НЕ ЗАМЕНА — ядро загрузчика.
// =============================================================================
describe('load-entity-translations — mergeTranslations (слияние)', () => {
  const F = [...CATEGORY_TR_FIELDS];

  it('пустой existing (null/undefined/{}) → пишется входной оверлей', () => {
    const incoming = { en: { name: 'Scarves' }, fr: { name: 'Foulards' } };
    const expected = { en: { name: 'Scarves' }, fr: { name: 'Foulards' } };
    expect(mergeTranslations(null, incoming, F, CATEGORIES)).toEqual(expected);
    expect(mergeTranslations(undefined, incoming, F, CATEGORIES)).toEqual(expected);
    expect(mergeTranslations({}, incoming, F, CATEGORIES)).toEqual(expected);
  });

  it('существующая локаль с ДРУГИМИ полями — поля объединяются, ничего не теряется', () => {
    const existing = { en: { seoTitle: 'Silk scarves — shop' } };
    const merged = mergeTranslations(existing, { en: { name: 'Scarves' } }, F, CATEGORIES);
    expect(merged).toEqual({ en: { seoTitle: 'Silk scarves — shop', name: 'Scarves' } });
  });

  it('локаль, которой нет во входе, остаётся нетронутой', () => {
    const existing = { fr: { name: 'Foulards', seoTitle: 'Foulards en soie' } };
    const merged = mergeTranslations(existing, { en: { name: 'Scarves' } }, F, CATEGORIES);
    expect(merged.fr).toEqual({ name: 'Foulards', seoTitle: 'Foulards en soie' });
  });

  it('конфликт того же поля — входное значение перезаписывает существующее', () => {
    const merged = mergeTranslations(
      { en: { name: 'Old' } },
      { en: { name: 'New' } },
      F,
      CATEGORIES,
    );
    expect(merged.en).toEqual({ name: 'New' });
  });

  it('поле вне whitelist отсекается МОЛЧА (существующие поля целы)', () => {
    const merged = mergeTranslations(
      { en: { name: 'Scarves' } },
      { en: { name: 'Scarves', slug: 'hacked', price: '1' } },
      F,
      CATEGORIES,
    );
    expect(merged.en).toEqual({ name: 'Scarves' });
  });

  it('неизвестная локаль отбрасывается', () => {
    const merged = mergeTranslations({}, { de: { name: 'Schals' } }, F, CATEGORIES);
    expect(merged).toEqual({});
    expect(merged.de).toBeUndefined();
  });

  it('локаль по умолчанию (ru) в оверлей не пишется — база живёт в колонках', () => {
    const merged = mergeTranslations({}, { ru: { name: 'Платки' } }, F, CATEGORIES);
    expect(merged.ru).toBeUndefined();
  });

  it('пустая строка / пробелы / не-строка НЕ пишутся (пустой оверлей перекрыл бы базу)', () => {
    const merged = mergeTranslations(
      { en: { name: 'Scarves' } },
      { en: { name: '', description: '   ', seoTitle: 42, ogTitle: null } },
      F,
      CATEGORIES,
    );
    expect(merged.en).toEqual({ name: 'Scarves' });
  });

  it('локаль без единого валидного поля не создаётся вовсе (нет пустого {})', () => {
    const merged = mergeTranslations({}, { en: { name: '' }, fr: {} }, F, CATEGORIES);
    expect(merged).toEqual({});
  });

  it('existing НЕ мутируется (возвращается новый объект)', () => {
    const existing = { en: { name: 'Old' } };
    const merged = mergeTranslations(existing, { en: { name: 'New' } }, F, CATEGORIES);
    expect(existing).toEqual({ en: { name: 'Old' } });
    expect(merged).not.toBe(existing);
    expect(merged.en).not.toBe(existing.en);
  });

  it('snake_case-ключ входа приводится к camelCase (грабля миграции 0055)', () => {
    const merged = mergeTranslations(
      {},
      { en: { seo_title: 'Silk scarves', seo_description: 'Buy silk scarves' } },
      [...PRODUCT_TR_FIELDS],
      CATEGORIES,
    );
    expect(merged.en).toEqual({ seoTitle: 'Silk scarves', seoDescription: 'Buy silk scarves' });
  });

  it('при коллизии snake_case и camelCase во входе побеждает camelCase — при ЛЮБОМ порядке ключей', () => {
    // Порядок ключей в JSON-источнике произволен. Без guard'а нормализации
    // (camelSuppliedDirectly) исход зависел бы от порядка вставки: snake-ключ,
    // идущий ПОСЛЕ camel-ключа, затёр бы canonical значением legacy. Поэтому
    // проверяем ОБА порядка — иначе тест проходит по совпадению.
    const camelFirst = mergeTranslations(
      {},
      { en: { seoTitle: 'canonical', seo_title: 'legacy' } },
      [...PRODUCT_TR_FIELDS],
      CATEGORIES,
    );
    expect(camelFirst.en).toEqual({ seoTitle: 'canonical' });

    const snakeFirst = mergeTranslations(
      {},
      { en: { seo_title: 'legacy', seoTitle: 'canonical' } },
      [...PRODUCT_TR_FIELDS],
      CATEGORIES,
    );
    expect(snakeFirst.en).toEqual({ seoTitle: 'canonical' });
  });

  it('snake_case-ключ применяется, если camel-дубль во входе пустой (а не молча теряется)', () => {
    const merged = mergeTranslations(
      {},
      { en: { seoTitle: '   ', seo_title: 'legacy' } },
      [...PRODUCT_TR_FIELDS],
      CATEGORIES,
    );
    expect(merged.en).toEqual({ seoTitle: 'legacy' });
  });

  it('битый existing (не объект / локаль-скаляр) не ломает слияние', () => {
    expect(mergeTranslations('junk', { en: { name: 'N' } }, F, CATEGORIES)).toEqual({
      en: { name: 'N' },
    });
    expect(mergeTranslations({ en: 'junk' }, { en: { name: 'N' } }, F, CATEGORIES)).toEqual({
      en: { name: 'N' },
    });
  });

  it('без явного списка локалей действует платформенный дефолт (ru отсечён)', () => {
    expect(DEFAULT_OVERLAY_LOCALES).toEqual(['en', 'fr']);
    const merged = mergeTranslations({}, { en: { name: 'A' }, ru: { name: 'Б' } }, F);
    expect(merged).toEqual({ en: { name: 'A' } });
  });

  it('ИДЕМПОТЕНТНОСТЬ: повторное слияние того же входа ничего не меняет', () => {
    const existing = { en: { seoTitle: 'kept' }, fr: { name: 'Foulards' } };
    const incoming = { en: { name: 'Scarves' }, fr: { name: 'Foulards' } };
    const once = mergeTranslations(existing, incoming, F, CATEGORIES);
    const twice = mergeTranslations(once, incoming, F, CATEGORIES);
    expect(twice).toEqual(once);
    expect(diffTranslations(once, twice).changed).toBe(false);
  });
});

// =============================================================================
// (г) Diff для --dry-run.
// =============================================================================
describe('load-entity-translations — diffTranslations', () => {
  const F = [...CATEGORY_TR_FIELDS];

  it('новые поля → added, изменённые → overwritten, changed=true', () => {
    const existing = { en: { name: 'Old' } };
    const merged = mergeTranslations(
      existing,
      { en: { name: 'New', seoTitle: 'T' } },
      F,
      CATEGORIES,
    );
    const diff = diffTranslations(existing, merged);
    expect(diff.changed).toBe(true);
    expect(diff.locales.en.added).toEqual(['seoTitle']);
    expect(diff.locales.en.overwritten).toEqual([{ field: 'name', from: 'Old', to: 'New' }]);
  });

  it('совпадающее значение — не изменение (changed=false, локаль не в отчёте)', () => {
    const existing = { en: { name: 'Same' } };
    const merged = mergeTranslations(existing, { en: { name: 'Same' } }, F, CATEGORIES);
    const diff = diffTranslations(existing, merged);
    expect(diff.changed).toBe(false);
    expect(diff.locales).toEqual({});
  });

  it('новая локаль целиком попадает в added', () => {
    const diff = diffTranslations(null, { fr: { name: 'Foulards', seoTitle: 'S' } });
    expect(diff.changed).toBe(true);
    expect(diff.locales.fr.added).toEqual(['name', 'seoTitle']);
  });

  it('formatDiff даёт компактную однострочную сводку', () => {
    const diff = diffTranslations({ en: { name: 'Old' } }, { en: { name: 'New', seoTitle: 'T' } });
    const line = formatDiff(diff);
    expect(line).toContain('en');
    expect(line).toContain('seoTitle');
    expect(line).toContain('name');
  });
});

// =============================================================================
// Разбор файла-источника и конфигурации языков.
// =============================================================================
describe('load-entity-translations — parseSource', () => {
  it('{slug: {locale: {field: value}}} → Map<slug, оверлей>', () => {
    const map = parseSource({
      aksessuari: { en: { name: 'Accessories' }, fr: { name: 'Accessoires' } },
      art: { en: { name: 'Art' } },
    });
    expect(map.size).toBe(2);
    expect(map.get('aksessuari')).toEqual({ en: { name: 'Accessories' }, fr: { name: 'Accessoires' } });
    expect(map.get('art')).toEqual({ en: { name: 'Art' } });
  });

  it('мусорные значения slug (не объект) отбрасываются', () => {
    const map = parseSource({ ok: { en: { name: 'A' } }, bad: 'x', nil: null, arr: [] });
    expect([...map.keys()]).toEqual(['ok']);
  });

  it('не-объект на входе (массив/строка/null) → бросает', () => {
    expect(() => parseSource([])).toThrow();
    expect(() => parseSource('x')).toThrow();
    expect(() => parseSource(null)).toThrow();
  });
});

describe('load-entity-translations — parseArgs', () => {
  it('разбирает --entity, путь к файлу, --dry-run и --locales', () => {
    expect(parseArgs(['--entity=categories', '/data/tr.json', '--dry-run'])).toEqual({
      entity: 'categories',
      filePath: '/data/tr.json',
      dryRun: true,
      localesOverride: null,
    });
    expect(parseArgs(['/data/tr.json', '--entity=products', '--locales=EN, fr'])).toEqual({
      entity: 'products',
      filePath: '/data/tr.json',
      dryRun: false,
      localesOverride: ['en', 'fr'],
    });
  });

  it('без аргументов → пустые entity/filePath (main печатает usage и падает)', () => {
    expect(parseArgs([])).toMatchObject({ entity: '', filePath: '', dryRun: false });
  });
});

// =============================================================================
// GUARD по исходнику: запись в jsonb и пост-проверка типа (БД в юнитах нет).
// =============================================================================
describe('load-entity-translations — guard записи в jsonb', () => {
  const src = readFileSync(new URL('../../scripts/load-entity-translations.mjs', import.meta.url), 'utf8');

  it('оверлей биндится через sql.json(...)::jsonb, а не сериализованной строкой', () => {
    expect(src).toMatch(/\$\{(?:sql|tx)\.json\(merged\)\}::jsonb/);
    expect(src).not.toContain('JSON.stringify(merged)');
  });

  it('после UPDATE тип проверяется jsonb_typeof по затронутой строке (RETURNING)', () => {
    expect(src).toContain('RETURNING slug, jsonb_typeof(translations) AS t');
    expect(src).toContain("written[0].t !== 'object'");
  });

  it('битый тип → ненулевой код возврата с перечислением slug', () => {
    expect(src).toMatch(/err\.badTypes\.map/);
    expect(src).toMatch(/if \(fatal\)[\s\S]{0,150}process\.exit\(1\)/);
  });

  it('имя таблицы подставляется идентификатором postgres.js, а не конкатенацией', () => {
    expect(src).toMatch(/\$\{(?:sql|tx)\(target\.table\)\}/);
    expect(src).not.toMatch(/FROM \$\{target\.table\}|UPDATE \$\{target\.table\}/);
  });

  it('залив идёт в ОДНОЙ транзакции (прерывание не оставляет полу-залитый оверлей)', () => {
    expect(src).toMatch(/await sql\.begin\(/);
    // Внутри транзакции работаем с tx, а не с пулом снаружи.
    expect(src).toMatch(/sql\.begin\(async \(tx\)/);
    expect(src).toMatch(/await tx`[\s\S]{0,200}UPDATE/);
  });

  it('битый jsonb-тип откатывает транзакцию (throw внутри begin, а не exit после commit)', () => {
    expect(src).toMatch(/badTypes\.length > 0[\s\S]{0,200}throw new JsonbTypeError/);
  });

  it('отсев валидацией считается отдельно от «уже залито» и виден оператору', () => {
    expect(src).toMatch(/rejected \+= 1/);
    expect(src).toMatch(/isSourceFullyRejected\(/);
    // Счётчик empty, врущий про «вход отсеян», больше не используется.
    expect(src).not.toMatch(/empty \+= 1/);
  });

  it('моноязычный магазин: выход без записи и без открытия транзакции', () => {
    const monoIdx = src.indexOf('locales.length === 0');
    const beginIdx = src.indexOf('await sql.begin(');
    expect(monoIdx).toBeGreaterThan(-1);
    // Ветка «заливать нечего» обязана отработать РАНЬШЕ открытия транзакции.
    expect(beginIdx).toBeGreaterThan(monoIdx);
    expect(src.slice(monoIdx, beginIdx)).toMatch(/process\.exit\(0\)/);
  });

  it('в шапке есть инструкция запуска в контейнере стенда (путь к whitelist — от скрипта)', () => {
    expect(src).toMatch(/\/app\/scripts\//);
  });

  it('whitelist полей не дублируется в скрипте (только имена констант fields.ts)', () => {
    // Список полей обязан приходить из lib/i18n/fields.ts. Прямых литералов
    // переводимых полей в скрипте быть не должно.
    expect(src).not.toMatch(/['"]seoDescription['"]/);
    expect(src).not.toMatch(/['"]ogTitle['"]/);
    expect(src).toContain('CATEGORY_TR_FIELDS');
  });
});

/**
 * МУЛЬТИТЕНАНТНОСТЬ: «моноязычный магазин» и «битая настройка» — РАЗНЫЕ случаи.
 * Валидная настройка с одним языком означает «оверлею заливать нечего», и подмена
 * её платформенным дефолтом залила бы в магазин языки, которых у него нет.
 */
describe('load-entity-translations — resolveOverlayLocales', () => {
  it('из shop_settings.i18n берёт locales минус defaultLocale (source=settings)', () => {
    expect(resolveOverlayLocales({ defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] })).toEqual({
      locales: ['en', 'fr'],
      source: 'settings',
    });
    expect(resolveOverlayLocales({ defaultLocale: 'EN', locales: ['EN', 'de'] })).toEqual({
      locales: ['de'],
      source: 'settings',
    });
  });

  it('МОНОЯЗЫЧНЫЙ магазин (валидная настройка) → пустой набор, НЕ платформенный дефолт', () => {
    expect(resolveOverlayLocales({ defaultLocale: 'ru', locales: ['ru'] })).toEqual({
      locales: [],
      source: 'settings',
    });
    // Дубли/регистр не превращают моноязычный магазин в многоязычный.
    expect(resolveOverlayLocales({ defaultLocale: 'ru', locales: ['ru', 'RU', ' ru '] })).toEqual({
      locales: [],
      source: 'settings',
    });
  });

  it('битая/отсутствующая настройка → платформенный дефолт с признаком source', () => {
    for (const raw of [null, undefined, 'junk', 42, [], {}, { locales: [] }, { locales: 'en' }]) {
      expect(resolveOverlayLocales(raw)).toEqual({
        locales: [...DEFAULT_OVERLAY_LOCALES],
        source: 'platform-default',
      });
    }
  });

  it('частичная настройка (locales без defaultLocale) считается битой, а не моноязычной', () => {
    expect(resolveOverlayLocales({ locales: ['ru', 'en'] })).toEqual({
      locales: [...DEFAULT_OVERLAY_LOCALES],
      source: 'platform-default',
    });
    expect(resolveOverlayLocales({ defaultLocale: '  ', locales: ['ru', 'en'] })).toEqual({
      locales: [...DEFAULT_OVERLAY_LOCALES],
      source: 'platform-default',
    });
  });

  it('мусор внутри валидного набора отбрасывается, а не роняет магазин в дефолт', () => {
    expect(resolveOverlayLocales({ defaultLocale: 'ru', locales: ['ru', 'en', 42, ''] })).toEqual({
      locales: ['en'],
      source: 'settings',
    });
  });
});

// =============================================================================
// Учёт результата залива: «нечего менять» ≠ «вход отсеян валидацией».
// =============================================================================
describe('load-entity-translations — countAcceptedFields', () => {
  const F = [...CATEGORY_TR_FIELDS];

  it('считает поля, которые реально пройдут валидацию (язык + whitelist + непустая строка)', () => {
    expect(countAcceptedFields({ en: { name: 'A' }, fr: { name: 'B' } }, F, CATEGORIES)).toBe(2);
    expect(countAcceptedFields({ en: { name: 'A', seoTitle: 'T' } }, F, CATEGORIES)).toBe(2);
  });

  it('0 — когда вход отсеян целиком: чужой язык, поле вне whitelist, пустые строки', () => {
    expect(countAcceptedFields({ de: { name: 'Schals' } }, F, CATEGORIES)).toBe(0);
    expect(countAcceptedFields({ ru: { name: 'Платки' } }, F, CATEGORIES)).toBe(0);
    expect(countAcceptedFields({ en: { price: '1', slug: 'x' } }, F, CATEGORIES)).toBe(0);
    expect(countAcceptedFields({ en: { name: '   ' } }, F, CATEGORIES)).toBe(0);
    expect(countAcceptedFields({}, F, CATEGORIES)).toBe(0);
  });

  it('НЕ зависит от того, залито ли уже это значение в БД (в отличие от diff.changed)', () => {
    const incoming = { en: { name: 'A' } };
    const existing = { en: { name: 'A' } };
    // Идемпотентный повтор: менять нечего, но вход валиден — это НЕ отсев.
    expect(diffTranslations(existing, mergeTranslations(existing, incoming, F, CATEGORIES)).changed).toBe(
      false,
    );
    expect(countAcceptedFields(incoming, F, CATEGORIES)).toBe(1);
  });
});

describe('load-entity-translations — isSourceFullyRejected', () => {
  it('true только когда НИ ОДНА строка не залита и не совпала, а отсев был', () => {
    expect(isSourceFullyRejected({ updated: 0, unchanged: 0, rejected: 5 })).toBe(true);
  });

  it('false, если что-то залито или уже совпадает (частичный отсев — предупреждение)', () => {
    expect(isSourceFullyRejected({ updated: 1, unchanged: 0, rejected: 5 })).toBe(false);
    expect(isSourceFullyRejected({ updated: 0, unchanged: 3, rejected: 1 })).toBe(false);
  });

  it('false без отсева (нормальный идемпотентный повтор и пустой источник)', () => {
    expect(isSourceFullyRejected({ updated: 0, unchanged: 10, rejected: 0 })).toBe(false);
    expect(isSourceFullyRejected({ updated: 0, unchanged: 0, rejected: 0 })).toBe(false);
  });
});
