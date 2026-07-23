/**
 * Нормализация ЛЕГАСИ-ключей оверлея translations (T1, ADR-i18n / docs/24 §1).
 *
 * WHY: ETL прошлых сессий заливал переводы ключами в snake_case (seo_title,
 * seo_description), тогда как единый whitelist lib/i18n/fields.ts — и, значит,
 * весь read/write-path админки и витрины — работает с camelCase (seoTitle).
 * Из-за расхождения переводы физически лежат в БД, но НЕ видны нигде: владелец
 * открывает вкладку EN и видит пустые SEO-поля.
 *
 * Модуль — ЧИСТЫЙ (без БД/Next): та же семантика, что у миграции 0055, чтобы
 * поведение можно было закрепить юнит-тестами, а будущий ETL мог прогнать
 * данные через normalizeLegacyTranslationKeys перед записью.
 */

import {
  BRAND_TR_FIELDS,
  CATEGORY_TR_FIELDS,
  CMS_PAGE_TR_FIELDS,
  DESIGNER_TR_FIELDS,
  PRODUCT_BLOCK_TR_FIELDS,
  PRODUCT_TR_FIELDS,
  VARIANT_TR_FIELDS,
} from './fields';
import type { TranslationsMap } from './types';

/** camelCase → snake_case (только для вывода карты алиасов, не для данных). */
export function toSnakeCase(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Объединение whitelist-полей всех сущностей — единственный источник имён. */
const ALL_TR_FIELDS: readonly string[] = Array.from(
  new Set<string>([
    ...PRODUCT_TR_FIELDS,
    ...BRAND_TR_FIELDS,
    ...CATEGORY_TR_FIELDS,
    ...DESIGNER_TR_FIELDS,
    ...VARIANT_TR_FIELDS,
    ...CMS_PAGE_TR_FIELDS,
    ...PRODUCT_BLOCK_TR_FIELDS,
  ]),
);

/**
 * Карта «мёртвый snake_case-ключ → живой camelCase-ключ». Выводится из whitelist,
 * поэтому новое многословное переводимое поле подхватывается автоматически.
 * Односложные поля (name/description/title/body) в карту не попадают: у них
 * snake-форма совпадает с camel-формой, переименовывать нечего.
 */
export const LEGACY_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    ALL_TR_FIELDS.filter((f) => toSnakeCase(f) !== f).map((f) => [toSnakeCase(f), f]),
  ),
);

export interface NormalizeLegacyKeysResult {
  /** true, если хотя бы один ключ был переименован. */
  changed: boolean;
  /** Новый оверлей (исходный не мутируется). */
  value: TranslationsMap;
}

/**
 * Переименовывает легаси-ключи оверлея в canonical camelCase по каждому языку
 * независимо.
 *
 * ПРИОРИТЕТ ПРИ КОЛЛИЗИИ (есть и seo_title, и seoTitle): побеждает camelCase.
 * Обоснование — camelCase-ключ единственный, который приложение умеет и читать,
 * и писать; непустое значение под ним могло появиться только из живого write-path
 * (правка владельца в админке), тогда как snake_case — заведомо старый машинный
 * залив ETL. Свежая ручная правка не должна проигрывать импорту.
 * ДАННЫЕ НЕ ТЕРЯЮТСЯ: в коллизии snake_case-ключ остаётся на месте нетронутым
 * (он всё равно игнорируется whitelist'ом, но пригоден для ручного разбора).
 *
 * Идемпотентно: после первого прогона переносить больше нечего.
 */
export function normalizeLegacyTranslationKeys(
  overlay: TranslationsMap | null | undefined,
): NormalizeLegacyKeysResult {
  if (!overlay || typeof overlay !== 'object') return { changed: false, value: {} };

  let changed = false;
  const out: TranslationsMap = {};

  for (const [locale, fields] of Object.entries(overlay)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      out[locale] = fields as Record<string, unknown>;
      continue;
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const camel = LEGACY_KEY_ALIASES[key];
      if (camel !== undefined && !Object.prototype.hasOwnProperty.call(fields, camel)) {
        next[camel] = value;
        changed = true;
      } else {
        next[key] = value;
      }
    }
    out[locale] = next;
  }

  return { changed, value: out };
}
