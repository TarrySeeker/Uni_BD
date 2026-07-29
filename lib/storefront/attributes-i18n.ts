/**
 * READ-PATH перевода ХАРАКТЕРИСТИК и ЦВЕТО-СВОТЧЕЙ товара (аудит minor №11, остаток).
 *
 * ПРОБЛЕМА. `products.attributes_cache` — ДЕНОРМАЛИЗОВАННАЯ проекция EAV вида
 * `{ "<код атрибута>": "<читаемое значение>" }` (lib/catalog/cache.ts). И ключ, и
 * значение попадают в кеш на языке по умолчанию магазина, а сам кеш переводимой
 * колонки не имеет и иметь не должен: это производная величина, её единственный
 * источник истины — таблицы `attributes` / `attribute_values`, у которых колонки
 * `translations` созданы миграцией 0034. Раньше DTO отдавал кеш СЫРЫМ
 * (`attributes: p.attributesCache ?? {}`), а `colors` копировались как есть — из-за
 * чего на en/fr витрине характеристики и подписи цветов оставались русскими.
 *
 * РЕШЕНИЕ. Кеш не трогаем (он остаётся быстрым и языконезависимым), а переводим его
 * НА ГРАНИЦЕ DTO по словарю, собранному из `attributes`/`attribute_values`:
 *   • ключ кеша (код атрибута) → локализованное `attributes.name`;
 *   • значение → локализованное `attribute_values.value`.
 * Чего в словаре нет — отдаём как есть: перевод НИКОГДА не теряет данные.
 *
 * Модуль ЧИСТЫЙ (без БД/Next) — запрос словаря живёт в lib/storefront/queries.ts,
 * поэтому логика переводима тестами на фикстурах.
 *
 * МУЛЬТИТЕНАНТНОСТЬ: ни одного зашитого кода атрибута/цвета — словарь целиком
 * приходит из данных конкретного магазина.
 */

import { localizeField } from '@/lib/i18n';
import type { TranslationsMap } from '@/lib/i18n';
import type { LocalizeCtx } from '@/lib/storefront/locale';
import { ATTRIBUTE_TR_FIELDS, ATTRIBUTE_VALUE_TR_FIELDS } from '@/lib/i18n/fields';

/** Строка справочника характеристик (attributes) для сборки словаря. */
export interface AttributeI18nRow {
  /** Стабильный код импорта ('color','size') — ключ в attributes_cache. НЕ переводится. */
  code: string;
  /** Базовое человекочитаемое имя (язык по умолчанию магазина). */
  name: string;
  translations?: TranslationsMap | null;
}

/** Строка словаря значений (attribute_values) для сборки словаря. */
export interface AttributeValueI18nRow {
  /** Код атрибута-владельца (для диагностики/группировки). */
  attributeCode: string;
  /** Базовое значение ('Шёлк', 'M') — оно же лежит в attributes_cache. */
  value: string;
  translations?: TranslationsMap | null;
}

/**
 * Словарь переводов характеристик. Ключи карт — БАЗОВЫЕ (дефолт-локальные) строки,
 * ровно те, что лежат в денормализованном кеше:
 *   • names  — код атрибута → его переводимая строка-запись;
 *   • values — базовое значение → его переводимая строка-запись.
 *
 * Значения индексируются по САМОМУ ЗНАЧЕНИЮ, а не по паре (атрибут, значение):
 * `attribute_values.value` уникален в пределах атрибута, но в кеше от атрибута
 * остаётся только код ключа, а цвето-свотчи (products.colors) вообще не хранят
 * ссылку на атрибут. Единый индекс по строке покрывает оба случая; коллизия
 * одинаковых написаний у разных атрибутов даёт один и тот же перевод — что
 * корректно, потому что переводится одно и то же слово.
 */
export interface AttributeDictionary {
  names: Map<string, { base: string; translations: TranslationsMap | null }>;
  values: Map<string, { base: string; translations: TranslationsMap | null }>;
}

/** Пустой словарь — «переводов нет», всё отдаётся базой. */
export function emptyAttributeDictionary(): AttributeDictionary {
  return { names: new Map(), values: new Map() };
}

/**
 * Собирает словарь из строк справочников. Пустые/пробельные ключи пропускаем:
 * по ним всё равно ничего не найти, а в карте они создавали бы ложные попадания.
 */
export function buildAttributeDictionary(
  attributes: readonly AttributeI18nRow[],
  values: readonly AttributeValueI18nRow[],
): AttributeDictionary {
  const dict = emptyAttributeDictionary();
  for (const a of attributes) {
    if (typeof a.code !== 'string' || a.code.trim() === '') continue;
    dict.names.set(a.code, { base: a.name, translations: a.translations ?? null });
  }
  for (const v of values) {
    if (typeof v.value !== 'string' || v.value.trim() === '') continue;
    // Первое вхождение выигрывает: порядок задаёт запрос (сортировка стабильна).
    if (!dict.values.has(v.value)) {
      dict.values.set(v.value, { base: v.value, translations: v.translations ?? null });
    }
  }
  return dict;
}

/** Локаль/дефолт из контекста; отсутствие контекста = базовый язык (переводов нет). */
function localesOf(loc: LocalizeCtx | null | undefined): { locale: string; defaultLocale: string } {
  return {
    locale: loc?.locale ?? loc?.defaultLocale ?? 'ru',
    defaultLocale: loc?.defaultLocale ?? 'ru',
  };
}

/**
 * Переводит одну запись словаря по указанному whitelisted-полю. Фолбэк — база
 * (localizeField уже реализует цепочку запрошенный→default→база), поэтому пустой
 * перевод НИКОГДА не затирает исходную строку.
 */
function translate(
  entry: { base: string; translations: TranslationsMap | null } | undefined,
  field: string,
  loc: LocalizeCtx | null | undefined,
): string | null {
  if (!entry) return null;
  const { locale, defaultLocale } = localesOf(loc);
  const out = localizeField(entry.base, entry.translations, locale, field, defaultLocale);
  return typeof out === 'string' && out.trim() !== '' ? out : entry.base;
}

/** Переводит ОДНО значение характеристики; нестроковые типы (число/булево) — как есть. */
function translateValue(
  value: unknown,
  dict: AttributeDictionary,
  loc: LocalizeCtx | null | undefined,
): unknown {
  if (typeof value !== 'string') return value;
  return translate(dict.values.get(value), ATTRIBUTE_VALUE_TR_FIELDS[0], loc) ?? value;
}

/**
 * Локализует денормализованный кеш характеристик: машинный код ключа заменяется
 * читаемым (и переведённым) именем характеристики, значение — переведённым
 * значением словаря.
 *
 * Инварианты:
 *  • форма результата та же (плоская карта) — контракт DTO не меняется;
 *  • код, которого нет в словаре, остаётся ключом как есть (данные не теряются);
 *  • мультизначные характеристики (массив) переводятся поэлементно;
 *  • нестроковые значения сохраняют тип;
 *  • dict = null/undefined → возвращаем копию входа (анти-регресс старых вызовов).
 */
export function localizeAttributesCache(
  cache: Record<string, unknown> | null | undefined,
  dict: AttributeDictionary | null | undefined,
  loc: LocalizeCtx | null | undefined,
): Record<string, unknown> {
  const src = cache ?? {};
  if (!dict) return { ...src };
  const out: Record<string, unknown> = {};
  for (const [code, value] of Object.entries(src)) {
    // Имя характеристики: перевод → база (читаемое имя) → сам код, если атрибута
    // в справочнике уже нет (удалён, а кеш ещё не пересобран).
    const name = translate(dict.names.get(code), ATTRIBUTE_TR_FIELDS[0], loc) ?? code;
    const translated = Array.isArray(value)
      ? value.map((v) => translateValue(v, dict, loc))
      : translateValue(value, dict, loc);
    // Коллизия имён (две характеристики с одинаковым переведённым именем) не должна
    // ронять запись: побеждает первая, как и в исходном кеше по порядку ключей.
    if (!(name in out)) out[name] = translated;
  }
  return out;
}

/** Дисплейный цвето-свотч (products.colors) — {hex,name}. */
export interface ColorSwatch {
  hex: string;
  name: string;
}

/**
 * Локализует имена цвето-свотчей (title/aria-label кружка на карточке). Имена
 * приходят из того же словаря значений, что и характеристики (обычно это значения
 * атрибута 'color'). Пустое имя остаётся пустым — подставлять туда что-либо было бы
 * выдумкой; hex не трогаем никогда (это идентификатор, а не текст).
 */
export function localizeColors(
  colors: readonly ColorSwatch[] | null | undefined,
  dict: AttributeDictionary | null | undefined,
  loc: LocalizeCtx | null | undefined,
): ColorSwatch[] {
  const src = colors ?? [];
  if (!dict) return src.map((c) => ({ hex: c.hex, name: c.name }));
  return src.map((c) => ({
    hex: c.hex,
    name: c.name ? (translate(dict.values.get(c.name), ATTRIBUTE_VALUE_TR_FIELDS[0], loc) ?? c.name) : c.name,
  }));
}
