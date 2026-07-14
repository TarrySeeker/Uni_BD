/**
 * Резолв переводимых значений на границе (ADR-i18n, docs/24 §1).
 *
 * Цепочка фолбэка: запрошенный язык → default(ru = базовая колонка) → null.
 * База никогда не дублируется в оверлей, поэтому для defaultLocale возвращается
 * базовое значение как есть. Все функции — чистые, без БД/Next.
 */

import type { Locale, TranslationsMap } from './types';

/** Значение «заполнено»? Пустая/пробельная строка и null/undefined — НЕ заполнено. */
export function isNonEmptyValue(v: unknown): boolean {
  if (v == null) {
    return false;
  }
  if (typeof v === 'string') {
    return v.trim().length > 0;
  }
  return true;
}

/**
 * Возвращает переведённое значение, если оно непусто, иначе — базовое.
 * Гарантия «никогда не пусто, где база есть».
 */
export function withFallback<T>(translated: T | null | undefined, base: T): T {
  return isNonEmptyValue(translated) ? (translated as T) : base;
}

/**
 * Локализует одно поле по цепочке запрошенный→default(ru)→null.
 * base — значение базовой (default-locale) колонки.
 */
export function localizeField(
  base: unknown,
  translations: TranslationsMap | null | undefined,
  locale: Locale,
  field: string,
  defaultLocale: Locale = 'ru',
): unknown {
  if (locale !== defaultLocale && translations) {
    const overlay = translations[locale];
    if (overlay && isNonEmptyValue(overlay[field])) {
      return overlay[field];
    }
  }
  return base ?? null;
}

/**
 * Локализует набор полей строки: возвращает НОВЫЙ объект с переведёнными
 * значениями whitelisted-полей. Непереводимые поля остаются как в base.
 */
export function localizeRow<R extends Record<string, unknown>>(
  base: R,
  translations: TranslationsMap | null | undefined,
  locale: Locale,
  fields: readonly (keyof R & string)[],
  defaultLocale: Locale = 'ru',
): R {
  if (locale === defaultLocale || !translations) {
    return { ...base };
  }
  const out: R = { ...base };
  for (const field of fields) {
    out[field] = localizeField(base[field], translations, locale, field, defaultLocale) as R[typeof field];
  }
  return out;
}

/** Простой объект (не массив, не null)? */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge базового структурного значения с per-locale патчем (для CMS-секций).
 * Патч несёт ТОЛЬКО изменённые ключи/элементы; пустые значения патча не затирают
 * базу. Массивы мержатся по индексу (неизменённые элементы сохраняются).
 */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) {
    const len = Math.max(base.length, patch.length);
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) {
      const b = base[i];
      const p = patch[i];
      if (p === undefined) {
        out.push(b);
      } else if (b === undefined) {
        out.push(p);
      } else {
        out.push(deepMerge(b, p));
      }
    }
    return out;
  }

  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = deepMerge(base[k], v);
    }
    return out;
  }

  // Лист: непустой патч побеждает, иначе сохраняем базу.
  return isNonEmptyValue(patch) ? patch : base;
}

/**
 * Локализует структурный контент (CMS-секции): deep-merge базового content с
 * оверлеем translations[locale]. Структурные ключи (type/section_key/order),
 * которые отсутствуют в патче, остаются из базы.
 */
export function localizeStructured(
  base: unknown,
  translations: TranslationsMap | null | undefined,
  locale: Locale,
  defaultLocale: Locale = 'ru',
): unknown {
  if (locale === defaultLocale || !translations) {
    return base;
  }
  const overlay = translations[locale];
  if (overlay == null) {
    return base;
  }
  return deepMerge(base, overlay);
}
