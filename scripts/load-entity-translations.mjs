// =============================================================================
// scripts/load-entity-translations.mjs
// -----------------------------------------------------------------------------
// УНИВЕРСАЛЬНЫЙ ETL-загрузчик i18n-оверлея `translations` (jsonb) для любой
// сущности платформы. Мультитенантен: сущность и данные приходят аргументами,
// в коде нет ни одного имени магазина. Сматчивает строки по `slug`.
//
// ЗАЧЕМ: базовый язык магазина живёт в обычных колонках (name/description/...),
// остальные — в оверлее `translations` (миграции 0034/0035/0047, ADR-i18n
// docs/24 §1). Если оверлей пуст, витрина на /en и /fr честно отдаёт базовый
// (русский) текст по цепочке фолбэка — переводы нужно ЗАЛИТЬ.
//
// ИСТОЧНИК (добывается координатором и передаётся ФАЙЛОМ) — JSON вида:
//   {
//     "<slug>": { "<locale>": { "<field>": "<перевод>", ... }, ... },
//     ...
//   }
// где locale — включённый язык магазина кроме базового, field — поле из
// whitelist сущности (lib/i18n/fields.ts).
//
// 🔴 СЛИЯНИЕ, А НЕ ЗАМЕНА. Часть строк уже переведена (руками владельца в
// админке или прошлым заливом). Загрузчик ДОПОЛНЯЕТ оверлей: чужие языки и
// чужие поля сохраняются, входные перезаписывают одноимённые. Полная замена
// колонки затёрла бы ручной труд владельца — так делать нельзя.
//
// ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ ПОЛЕЙ: whitelist НЕ дублируется здесь, а читается из
// lib/i18n/fields.ts (тот же список, что у read-path витрины и write-path
// админки). Скрипт на .mjs не может импортировать .ts, поэтому файл читается
// текстом и разбирается parseFieldWhitelists; паритет разбора с настоящими
// экспортами закреплён юнит-тестом (tests/etl/entity-translations.test.ts).
//
// ГРАБЛЯ (миграция 0055): прошлый ETL писал ключи в snake_case (seo_title), а
// приложение читает camelCase (seoTitle) — переводы лежали в БД мёртвыми. Здесь
// входные ключи нормализуются к camelCase; при коллизии побеждает camelCase.
//
// ГРАБЛЯ (scripts/load-product-colors.mjs): биндинг СЕРИАЛИЗОВАННОЙ СТРОКОЙ
// вместо sql.json() кладёт jsonb-строку вместо объекта — так на стенде легли 664
// товара. Пишем строго `${sql.json(obj)}::jsonb`, а пост-проверку типа делаем тем
// же запросом через RETURNING jsonb_typeof(translations): она видит уже
// записанное значение ровно затронутых строк. Не 'object' → exit≠0 с перечислением.
//
// ЯЗЫКИ (МУЛЬТИТЕНАНТНО, три РАЗНЫХ случая — их нельзя путать):
//   1) в shop_settings.i18n лежит ВАЛИДНАЯ конфигурация → берём её locales минус
//      базовый. Пустой результат ЛЕГИТИМЕН: моноязычному магазину в оверлей
//      заливать нечего — сообщаем оператору и выходим БЕЗ записи (exit 0). Подмена
//      платформенным дефолтом залила бы магазину языки, которых у него нет;
//   2) настройки нет / она битая → платформенный дефолт (en, fr) + ЯВНОЕ
//      предупреждение в логе, чтобы оператор починил настройки магазина;
//   3) передан --locales=... → override (диагностика), логируется как override.
// Неизвестные языки и поля вне whitelist отбрасываются молча (симметрия с админкой).
//
// ПОДКЛЮЧЕНИЕ К БД (тот же приоритет, что db/seed/owner.mjs):
//   1) SEED_DATABASE_URL — явный override;
//   2) PG* (PGUSER/PGPASSWORD/PGHOST/PGPORT/PGDATABASE);
//   3) DATABASE_URL — fallback.
//
// ЗАПУСК:
//   node scripts/load-entity-translations.mjs --entity=categories <file.json>
//   node scripts/load-entity-translations.mjs --entity=categories <file.json> --dry-run
//     (--dry-run: печатает план изменений по slug, в БД НЕ пишет)
//   --locales=en,fr — override набора языков (диагностика; обычно не нужен)
//
// ЗАПУСК НА СТЕНДЕ (в контейнере app): скопировать в контейнер И файл-источник, И
// сам скрипт, причём скрипт — в `/app/scripts/`. Путь к whitelist (FIELDS_SOURCE_PATH)
// резолвится ОТНОСИТЕЛЬНО файла скрипта (`../lib/i18n/fields.ts`), поэтому из другого
// каталога скрипт не найдёт lib/i18n/fields.ts и упадёт на чтении whitelist:
//   docker cp scripts/load-entity-translations.mjs <app>:/app/scripts/
//   docker cp /tmp/tr.json <app>:/tmp/tr.json
//   docker exec <app> node /app/scripts/load-entity-translations.mjs \
//     --entity=categories /tmp/tr.json --dry-run
//
// ИДЕМПОТЕНТНОСТЬ: строка обновляется только если слияние реально что-то меняет
// (иначе даже updated_at не трогаем). Повторный запуск того же файла — no-op.
//
// АТОМАРНОСТЬ: весь залив идёт в ОДНОЙ транзакции (sql.begin). Прерывание на
// середине (Ctrl+C, обрыв ssh, ошибка SQL, битый jsonb-тип) откатывает всё —
// частично залитого оверлея не остаётся. Пост-проверка jsonb_typeof живёт внутри
// транзакции: RETURNING видит собственную запись, и при типе ≠ 'object' мы БРОСАЕМ
// (⇒ ROLLBACK), а не выходим после коммита. Цена — построчный SELECT+UPDATE в одной
// транзакции (для 848 товаров ~1700 round-trip'ов по локальному сокету, единицы
// секунд) и блокировки затронутых строк на время залива; для ETL это приемлемо.
//
// СЧЁТЧИКИ (важно оператору, см. ниже exit-код): «без изменений» = уже залито
// (норма), «отсеяно валидацией» = у строки не осталось НИ ОДНОГО валидного поля
// (чужой язык / поле вне whitelist / пустые строки) — залив для неё НЕ состоялся.
//
// КОД ВОЗВРАТА: 0 — успех (неизвестные slug и частичный отсев не ошибка, но громко
// логируются); ≠0 — фатально (нет файла/сущности, битый JSON, нет подключения,
// ошибка SQL, битый тип jsonb, а также источник, отсеянный ЦЕЛИКОМ — тогда залив
// не состоялся ни для одной строки, и молчаливый exit 0 обманул бы оператора).
// =============================================================================

import { readFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Оверлей переводов одной строки: { [locale]: { [field]: value } }.
 * @typedef {Record<string, Record<string, string>>} TranslationsOverlay
 */

/**
 * Отчёт о том, что изменится в оверлее (для --dry-run и решения «писать ли UPDATE»).
 * @typedef {{ changed: boolean, locales: Record<string, { added: string[], overwritten: { field: string, from: unknown, to: unknown }[] }> }} TranslationsDiff
 */

/**
 * Сущность → таблица + имя константы whitelist в lib/i18n/fields.ts.
 * ЕДИНСТВЕННОЕ место расширения: добавил строку — сущность поддержана.
 * Требования к таблице: колонки `slug`, `translations jsonb`, `updated_at`.
 */
export const ENTITY_TARGETS = Object.freeze({
  categories: { table: 'categories', fieldsConst: 'CATEGORY_TR_FIELDS' },
  products: { table: 'products', fieldsConst: 'PRODUCT_TR_FIELDS' },
  designers: { table: 'designers', fieldsConst: 'DESIGNER_TR_FIELDS' },
  brands: { table: 'brands', fieldsConst: 'BRAND_TR_FIELDS' },
  cms_pages: { table: 'cms_pages', fieldsConst: 'CMS_PAGE_TR_FIELDS' },
});

/** Путь к единому источнику правды переводимых полей. */
export const FIELDS_SOURCE_PATH = new URL('../lib/i18n/fields.ts', import.meta.url);

/**
 * Платформенный дефолт языков — зеркало DEFAULT_LOCALE_CONFIG (lib/i18n/config.ts).
 * Применяется ТОЛЬКО когда в shop_settings.i18n нет валидной конфигурации.
 */
const PLATFORM_DEFAULT_LOCALE_CONFIG = { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] };

/** Языки оверлея по умолчанию (включённые минус базовый). */
export const DEFAULT_OVERLAY_LOCALES = Object.freeze(
  PLATFORM_DEFAULT_LOCALE_CONFIG.locales.filter(
    (l) => l !== PLATFORM_DEFAULT_LOCALE_CONFIG.defaultLocale,
  ),
);

function info(msg) {
  console.log(`  [etl:i18n] ${msg}`);
}
function warn(msg) {
  console.warn(`  [etl:i18n] ⚠ ${msg}`);
}

/**
 * Строит подключение к БД (см. шапку, порядок приоритета).
 * Возвращает { kind:'url'|'options', value } либо null.
 */
function resolveConnection() {
  if (process.env.SEED_DATABASE_URL) {
    return { kind: 'url', value: process.env.SEED_DATABASE_URL };
  }
  if (process.env.PGUSER || process.env.PGHOST) {
    return {
      kind: 'options',
      value: {
        host: process.env.PGHOST ?? 'localhost',
        port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
      },
    };
  }
  if (process.env.DATABASE_URL) {
    return { kind: 'url', value: process.env.DATABASE_URL };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Единый источник правды полей.
// -----------------------------------------------------------------------------

/**
 * Достаёт из ТЕКСТА lib/i18n/fields.ts все whitelist-константы вида
 * `export const NAME = ['a', 'b'] as const;` → { NAME: ['a','b'] }.
 * Экспорты-объекты (CMS_SECTION_TR_FIELDS: Record<...>) игнорируются: их
 * whitelist задаётся по типу секции и плоскому заливу не подходит.
 * Чистая функция; паритет с настоящими экспортами закреплён юнит-тестом.
 *
 * @param {string} source
 * @returns {Record<string, string[]>}
 */
export function parseFieldWhitelists(source) {
  /** @type {Record<string, string[]>} */
  const out = {};
  const re = /export\s+const\s+([A-Z0-9_]+)\s*(?::[^=]+)?=\s*\[([^\]]*)\]\s*as\s+const\s*;/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const fields = [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map((q) => q[1]);
    out[m[1]] = fields;
  }
  return out;
}

/**
 * Читает и разбирает lib/i18n/fields.ts (по умолчанию — FIELDS_SOURCE_PATH).
 *
 * @param {URL | string} [path]
 * @returns {Record<string, string[]>}
 */
export function readFieldWhitelists(path = FIELDS_SOURCE_PATH) {
  return parseFieldWhitelists(readFileSync(path, 'utf8'));
}

/**
 * Отдаёт whitelist по имени константы. Бросает, если константы нет или она
 * пуста: молчаливый пустой список отсёк бы ВСЕ поля и залил пустой оверлей.
 *
 * @param {string} fieldsConst
 * @param {string} [source] текст fields.ts (по умолчанию читается с диска)
 * @returns {string[]}
 */
export function loadFieldWhitelist(fieldsConst, source) {
  const parsed = typeof source === 'string' ? parseFieldWhitelists(source) : readFieldWhitelists();
  const fields = parsed[fieldsConst];
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(
      `В lib/i18n/fields.ts не найден непустой whitelist ${fieldsConst} — обнови карту ENTITY_TARGETS.`,
    );
  }
  return fields;
}

/**
 * Резолвит аргумент --entity в цель залива. Бросает со списком доступных.
 *
 * @param {string} name
 * @returns {{ entity: string, table: string, fieldsConst: string }}
 */
export function resolveEntity(name) {
  const target = Object.prototype.hasOwnProperty.call(ENTITY_TARGETS, name)
    ? ENTITY_TARGETS[name]
    : undefined;
  if (!target) {
    throw new Error(
      `Неизвестная сущность '${name}'. Доступны: ${Object.keys(ENTITY_TARGETS).join(', ')}.`,
    );
  }
  return { entity: name, ...target };
}

// -----------------------------------------------------------------------------
// Языки.
// -----------------------------------------------------------------------------

/** Нормализация тега языка — как normalizeLocale (lib/i18n/locale-token.ts). */
function normalizeLocale(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Языки оверлея из значения shop_settings.i18n: включённые минус базовый.
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ: различаем «валидную настройку» и «битую/отсутствующую»
 * (см. шапку). Пустой результат при ВАЛИДНОЙ настройке — не ошибка, а факт
 * «магазин моноязычный»; подставлять вместо него платформенный дефолт нельзя,
 * иначе в магазин зальются языки, которых у него нет. Признак `source` нужен
 * вызывающему, чтобы выбрать реакцию: предупредить о битых настройках или
 * честно сказать «заливать нечего» и не писать в БД.
 *
 * Валидной считается та же форма, что принимает parseLocaleConfig
 * (lib/i18n/config.ts): объект с непустой строкой defaultLocale и непустым
 * массивом locales. Мусор ВНУТРИ валидного массива отбрасывается поштучно.
 *
 * @param {unknown} raw
 * @returns {{ locales: string[], source: 'settings' | 'platform-default' }}
 */
export function resolveOverlayLocales(raw) {
  const fallback = () => ({ locales: [...DEFAULT_OVERLAY_LOCALES], source: 'platform-default' });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback();
  if (!Array.isArray(raw.locales) || raw.locales.length === 0) return fallback();

  const base = normalizeLocale(raw.defaultLocale);
  if (!base) return fallback(); // частичная настройка без базового языка — битая

  const out = [];
  for (const l of raw.locales) {
    const n = normalizeLocale(l);
    if (n && n !== base && !out.includes(n)) out.push(n);
  }
  return { locales: out, source: 'settings' };
}

// -----------------------------------------------------------------------------
// Слияние оверлея.
// -----------------------------------------------------------------------------

/** camelCase → snake_case (для карты легаси-алиасов; ср. lib/i18n/legacy-keys.ts). */
function toSnakeCase(field) {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Карта «легаси snake_case-ключ → canonical camelCase» из whitelist сущности.
 * Односложные поля (name/title/body) не попадают: snake-форма совпадает с camel.
 */
function legacyAliases(allowedFields) {
  const map = new Map();
  for (const f of allowedFields) {
    const snake = toSnakeCase(f);
    if (snake !== f) map.set(snake, f);
  }
  return map;
}

/** Значение годно к записи только если это НЕПУСТАЯ строка (см. mergeTranslations). */
function isWritableValue(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * СЛИЯНИЕ оверлея переводов одной строки: existing ⊕ incoming.
 *
 * Правила:
 *  - языки вне allowedLocales отбрасываются (базовый язык в оверлей не пишется —
 *    он живёт в обычных колонках, дубль рассинхронизировался бы);
 *  - поля вне allowedFields отбрасываются молча (симметрия с write-path админки);
 *  - ключи входа приводятся к camelCase; при коллизии с camelCase-ключом того же
 *    входа побеждает camelCase (грабля миграции 0055);
 *  - пустые строки/пробелы/не-строки НЕ пишутся: пустой оверлей ХУЖЕ отсутствующего,
 *    так как перекрывает базовую колонку и витрина показала бы пустоту;
 *  - локаль, у которой не осталось ни одного валидного поля, не создаётся;
 *  - существующие поля локали сохраняются, одноимённые входные их перезаписывают.
 *
 * Чистая функция: existing не мутируется, возвращается новый объект.
 * Идемпотентна: mergeTranslations(mergeTranslations(e,i,…), i, …) === первый результат.
 *
 * @param {unknown} existing текущее значение колонки translations
 * @param {unknown} incoming оверлей из файла-источника
 * @param {readonly string[]} allowedFields whitelist полей сущности (lib/i18n/fields.ts)
 * @param {readonly string[]} [allowedLocales] языки оверлея магазина
 * @returns {TranslationsOverlay}
 */
export function mergeTranslations(
  existing,
  incoming,
  allowedFields,
  allowedLocales = DEFAULT_OVERLAY_LOCALES,
) {
  const fields = new Set(allowedFields);
  const locales = new Set(allowedLocales.map(normalizeLocale));
  const aliases = legacyAliases(allowedFields);

  /** @type {TranslationsOverlay} */
  const out = {};
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [locale, values] of Object.entries(existing)) {
      // Чужой/битый формат локали не переносим в новый объект как есть только
      // если вход её трогает (ниже она будет пересобрана с нуля).
      out[locale] =
        values && typeof values === 'object' && !Array.isArray(values) ? { ...values } : values;
    }
  }

  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return out;

  for (const [rawLocale, rawValues] of Object.entries(incoming)) {
    const locale = normalizeLocale(rawLocale);
    if (!locales.has(locale)) continue;
    if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) continue;

    // Нормализация ключей входа: snake_case → camelCase, camelCase приоритетнее.
    const patch = {};
    for (const [rawKey, value] of Object.entries(rawValues)) {
      const key = fields.has(rawKey) ? rawKey : (aliases.get(rawKey) ?? rawKey);
      if (!fields.has(key)) continue;
      if (!isWritableValue(value)) continue;
      const camelSuppliedDirectly = key !== rawKey && Object.prototype.hasOwnProperty.call(rawValues, key);
      if (camelSuppliedDirectly && isWritableValue(rawValues[key])) continue;
      patch[key] = value.trim();
    }
    if (Object.keys(patch).length === 0) continue;

    const current = out[locale];
    const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    out[locale] = { ...base, ...patch };
  }

  return out;
}

/**
 * Сколько полей входа РЕАЛЬНО пройдёт валидацию (язык из набора + поле из
 * whitelist + непустая строка). Нужно, чтобы отличить два состояния, которые
 * diffTranslations схлопывает в одно «changed=false»:
 *   - вход валиден, но всё уже залито → идемпотентный повтор, НОРМА;
 *   - вход отсеян целиком → залив для строки НЕ состоялся, оператору нужен сигнал.
 * Считаем тем же слиянием (пустой existing), чтобы правила валидации не
 * разъехались с mergeTranslations. Чистая функция.
 *
 * @param {unknown} incoming
 * @param {readonly string[]} allowedFields
 * @param {readonly string[]} [allowedLocales]
 * @returns {number}
 */
export function countAcceptedFields(incoming, allowedFields, allowedLocales) {
  const fresh = mergeTranslations({}, incoming, allowedFields, allowedLocales);
  let n = 0;
  for (const values of Object.values(fresh)) {
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      n += Object.keys(values).length;
    }
  }
  return n;
}

/**
 * Источник отсеян ЦЕЛИКОМ: ни одна строка не залита и ни одна не совпала с БД, но
 * отсев валидацией был. Значит залив не состоялся вообще (типовая причина —
 * ключи полей/языков в файле-источнике не те) и exit 0 обманул бы оператора.
 * Частичный отсев остаётся успехом с громким предупреждением.
 *
 * @param {{ updated: number, unchanged: number, rejected: number }} counters
 * @returns {boolean}
 */
export function isSourceFullyRejected({ updated, unchanged, rejected }) {
  return rejected > 0 && updated === 0 && unchanged === 0;
}

/**
 * Diff «что изменится» между существующим оверлеем и результатом слияния.
 * Возвращает { changed, locales: { [locale]: { added:[field], overwritten:[{field,from,to}] } } }.
 * Локали без изменений в отчёт не попадают — на этом же строится идемпотентность
 * записи (changed=false ⇒ UPDATE не выполняется).
 *
 * @param {unknown} existing
 * @param {unknown} merged
 * @returns {TranslationsDiff}
 */
export function diffTranslations(existing, merged) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  /** @type {TranslationsDiff['locales']} */
  const locales = {};
  let changed = false;

  for (const [locale, values] of Object.entries(merged ?? {})) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const before = base[locale];
    const prev = before && typeof before === 'object' && !Array.isArray(before) ? before : {};
    const added = [];
    const overwritten = [];
    for (const [field, value] of Object.entries(values)) {
      if (!Object.prototype.hasOwnProperty.call(prev, field)) {
        added.push(field);
      } else if (prev[field] !== value) {
        overwritten.push({ field, from: prev[field], to: value });
      }
    }
    if (added.length > 0 || overwritten.length > 0) {
      locales[locale] = { added, overwritten };
      changed = true;
    }
  }

  return { changed, locales };
}

/**
 * Однострочная сводка diff'а для лога --dry-run: `en: +seoTitle ~name`.
 *
 * @param {TranslationsDiff} diff
 * @returns {string}
 */
export function formatDiff(diff) {
  const parts = [];
  for (const [locale, d] of Object.entries(diff.locales)) {
    const items = [
      ...d.added.map((f) => `+${f}`),
      ...d.overwritten.map((o) => `~${o.field}`),
    ];
    parts.push(`${locale}: ${items.join(' ')}`);
  }
  return parts.join('; ');
}

// -----------------------------------------------------------------------------
// Источник.
// -----------------------------------------------------------------------------

/**
 * Разбирает файл-источник {slug: {locale: {field: value}}} → Map<slug, оверлей>.
 * Мусорные значения (не объект) отбрасываются. Чистая функция.
 *
 * @param {unknown} obj
 * @returns {Map<string, unknown>}
 */
export function parseSource(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(
      'Источник должен быть JSON-объектом вида {slug: {locale: {field: "перевод"}}}.',
    );
  }
  const map = new Map();
  for (const [slug, value] of Object.entries(obj)) {
    if (typeof slug !== 'string' || slug.length === 0) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    map.set(slug, value);
  }
  return map;
}

// -----------------------------------------------------------------------------
// CLI.
// -----------------------------------------------------------------------------

const USAGE =
  'Использование: node scripts/load-entity-translations.mjs --entity=<' +
  Object.keys(ENTITY_TARGETS).join('|') +
  '> <translations.json> [--dry-run] [--locales=en,fr]';

/**
 * Разбирает argv в { entity, filePath, dryRun, localesOverride }. Чистая функция.
 *
 * @param {string[]} argv
 * @returns {{ entity: string, filePath: string, dryRun: boolean, localesOverride: string[] | null }}
 */
export function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const entityArg = argv.find((a) => a.startsWith('--entity='));
  const localesArg = argv.find((a) => a.startsWith('--locales='));
  const filePath = argv.find((a) => !a.startsWith('--'));
  return {
    entity: entityArg ? entityArg.slice('--entity='.length) : '',
    filePath: filePath ?? '',
    dryRun,
    localesOverride: localesArg
      ? localesArg
          .slice('--locales='.length)
          .split(',')
          .map((l) => l.trim().toLowerCase())
          .filter(Boolean)
      : null,
  };
}

/**
 * Сигнальная ошибка: записанное значение оказалось не jsonb-объектом. Бросается
 * внутри транзакции, чтобы получить ROLLBACK; наружу выносит список строк.
 */
class JsonbTypeError extends Error {
  /** @param {{ slug: string, t: string }[]} badTypes */
  constructor(badTypes) {
    super('translations записан не объектом');
    this.name = 'JsonbTypeError';
    this.badTypes = badTypes;
  }
}

async function main() {
  const { entity, filePath, dryRun, localesOverride } = parseArgs(process.argv.slice(2));

  if (!entity || !filePath) {
    console.error(USAGE);
    process.exit(1);
  }

  // Пустой override (`--locales=`) — ошибка аргумента, а не «моноязычный магазин»:
  // ловим до открытия подключения.
  if (localesOverride && localesOverride.length === 0) {
    console.error('  [etl:i18n] Пустой --locales= — укажите хотя бы один язык или уберите флаг.');
    process.exit(1);
  }

  let target;
  let allowedFields;
  try {
    target = resolveEntity(entity);
    allowedFields = loadFieldWhitelist(target.fieldsConst);
  } catch (err) {
    console.error(`  [etl:i18n] ${err.message}`);
    process.exit(1);
  }

  let bySlug;
  try {
    bySlug = parseSource(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch (err) {
    console.error(`  [etl:i18n] Не удалось прочитать/разобрать ${filePath}: ${err.message}`);
    process.exit(1);
  }

  info(`Сущность: ${entity} (таблица ${target.table}); полей в whitelist: ${allowedFields.length}.`);
  info(`Источник: ${bySlug.size} строк (slug) из ${filePath}.`);
  if (dryRun) info('Режим --dry-run: запись в БД НЕ производится.');

  const conn = resolveConnection();
  if (!conn) {
    console.error('  [etl:i18n] Не заданы параметры подключения (SEED_DATABASE_URL / PG* / DATABASE_URL).');
    process.exit(1);
  }

  const sql =
    conn.kind === 'url'
      ? postgres(conn.value, { connection: { application_name: 'admik_etl_i18n' } })
      : postgres({ ...conn.value, connection: { application_name: 'admik_etl_i18n' } });

  let updated = 0;
  /** Уже залито: вход валиден, но слияние ничего не меняет (идемпотентный повтор). */
  let unchanged = 0;
  let unknown = 0;
  /** Отсеяно валидацией: у строки не осталось ни одного валидного поля. */
  let rejected = 0;
  /** Строки, у которых после записи jsonb_typeof(translations) ≠ 'object'. */
  const badTypes = [];
  const rejectedSlugs = [];

  let fatal = null;

  try {
    let locales;
    if (localesOverride) {
      locales = localesOverride;
      info(`Языки оверлея (--locales, override): ${locales.join(', ')}.`);
    } else {
      const rows = await sql`SELECT value FROM shop_settings WHERE setting_key = 'i18n'`;
      const resolved = resolveOverlayLocales(rows[0]?.value);
      locales = resolved.locales;
      if (resolved.source === 'platform-default') {
        warn(
          'В shop_settings.i18n нет валидной конфигурации языков — беру платформенный ' +
            `дефолт: ${locales.join(', ')}. Проверьте настройки языков магазина в админке.`,
        );
      } else if (locales.length === 0) {
        // ЛЕГИТИМНЫЙ случай: магазин моноязычный, оверлей ему не нужен. Пишем
        // только базовые колонки, поэтому заливать нечего — выходим без записи
        // и НЕ открывая транзакцию (см. шапку, случай 1).
        info(
          'Магазин моноязычный: в shop_settings.i18n включён только базовый язык — ' +
            'оверлею переводов заливать нечего. Запись НЕ производилась.',
        );
        await sql.end({ timeout: 5 });
        process.exit(0);
      } else {
        info(`Языки оверлея: ${locales.join(', ')} (базовый язык в оверлей не пишется).`);
      }
    }

    // ОДНА ТРАНЗАКЦИЯ на весь залив: прерывание не оставляет полу-залитый оверлей
    // (см. шапку, «АТОМАРНОСТЬ»). Внутри работаем только с tx.
    await sql.begin(async (tx) => {
      for (const [slug, incoming] of bySlug) {
        // Отсев проверяем ДО запроса: он не зависит от БД, а лишний round-trip на
        // заведомо пустой вход не нужен.
        if (countAcceptedFields(incoming, allowedFields, locales) === 0) {
          rejected += 1;
          if (rejectedSlugs.length < 10) rejectedSlugs.push(slug);
          warn(`вход отсеян валидацией (ни одного валидного поля): ${slug}`);
          continue;
        }

        const rows = await tx`
          SELECT translations FROM ${tx(target.table)} WHERE slug = ${slug} LIMIT 1
        `;
        if (rows.length === 0) {
          unknown += 1;
          warn(`slug не найден (${target.table}): ${slug}`);
          continue;
        }

        const existing = rows[0].translations ?? {};
        const merged = mergeTranslations(existing, incoming, allowedFields, locales);
        const diff = diffTranslations(existing, merged);

        if (!diff.changed) {
          // Вход валиден (проверено выше), но всё уже лежит в БД — норма.
          unchanged += 1;
          continue;
        }

        if (dryRun) {
          info(`${slug} → ${formatDiff(diff)}`);
          updated += 1;
          continue;
        }

        // БИНДИНГ ОБЪЕКТОМ: только sql.json() кладёт jsonb-ОБЪЕКТ. Сериализованная
        // строка легла бы как jsonb-строка (см. грабли colors в шапке).
        //
        // ПОСТ-ПРОВЕРКА ТИПА идёт тем же запросом: RETURNING отдаёт УЖЕ ЗАПИСАННОЕ
        // значение, поэтому jsonb_typeof здесь проверяет ровно ту строку, которую
        // мы тронули (CHECK-констрейнты 0034/0035/0047 требуют того же — 'object').
        // Внутри транзакции RETURNING видит собственную запись до коммита.
        const written = await tx`
          UPDATE ${tx(target.table)}
          SET translations = ${tx.json(merged)}::jsonb, updated_at = now()
          WHERE slug = ${slug}
          RETURNING slug, jsonb_typeof(translations) AS t
        `;
        if (written.length === 0) {
          // Строку удалили между SELECT и UPDATE — не наша ошибка, но и не запись.
          unknown += 1;
          warn(`slug исчез во время залива (${target.table}): ${slug}`);
          continue;
        }
        if (written[0].t !== 'object') badTypes.push({ slug: written[0].slug, t: written[0].t });
        updated += 1;
      }

      // Битый тип бросаем ВНУТРИ транзакции: это откатывает весь залив, а не
      // оставляет в БД строки со jsonb-строкой вместо объекта.
      if (badTypes.length > 0) throw new JsonbTypeError(badTypes);
    });
  } catch (err) {
    if (err instanceof JsonbTypeError) {
      fatal =
        `${target.table}.translations записан НЕ объектом (jsonb_typeof): ` +
        err.badTypes.map((r) => `${r.slug}=${r.t}`).join(', ') +
        ' — транзакция откачена, в БД ничего не залито.';
    } else {
      throw err;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (fatal) {
    console.error(`  [etl:i18n] ${fatal}`);
    process.exit(1);
  }

  info(
    `Готово${dryRun ? ' (--dry-run)' : ''}. ` +
      `Строк ${dryRun ? 'к обновлению' : 'обновлено'}: ${updated}; ` +
      `без изменений (уже залито): ${unchanged}; отсеяно валидацией: ${rejected}.`,
  );
  if (rejected > 0) {
    warn(
      `ЗАЛИВ НЕ СОСТОЯЛСЯ для ${rejected} строк: вход отсеян валидацией целиком ` +
        `(${rejectedSlugs.join(', ')}${rejected > rejectedSlugs.length ? ', …' : ''}). ` +
        'Проверьте в файле-источнике имена языков, имена полей и пустые значения.',
    );
  }
  if (unknown > 0) warn(`Пропущено неизвестных slug: ${unknown} (не ошибка — каталоги расходятся).`);

  if (isSourceFullyRejected({ updated, unchanged, rejected })) {
    console.error(
      '  [etl:i18n] Источник отсеян ЦЕЛИКОМ: ни одна строка не залита. Это ошибка данных, ' +
        'а не успешный no-op.',
    );
    process.exit(1);
  }
  process.exit(0);
}

// Запуск только при прямом вызове (не при импорте чистых функций тестом).
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('  [etl:i18n] Фатальная ошибка:', err);
    process.exit(1);
  });
}
