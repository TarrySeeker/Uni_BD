/**
 * Zod-схемы ввода переводов (ADR-i18n, docs/24 §1).
 *
 * translationsInputSchema(whitelist, locales) строит схему, которая пропускает
 * ТОЛЬКО whitelisted-поля и ТОЛЬКО включённые языки — лишние поля/языки молча
 * отсекаются (Zod strip по умолчанию). Строки ограничены по длине (anti-tamper).
 *
 * mergeTranslations(existing, locale, patch) пишет ТОЛЬКО переданный язык, не
 * затрагивая переводы остальных языков.
 */

import { z } from 'zod';

import type { TranslationsMap } from './types';

/** Лимит длины одного переводимого поля по умолчанию (rich HTML тоже влезает). */
const DEFAULT_MAX_LENGTH = 20000;

export interface TranslationsSchemaOptions {
  /** Максимальная длина значения одного поля (символов). */
  maxLength?: number;
}

/**
 * Схема оверлея переводов: `{ [locale]: { [field]: string } }`.
 * - ключи вне `locales` отсекаются;
 * - поля вне `fieldWhitelist` отсекаются;
 * - значения — строки до maxLength.
 * Результат пригоден как частичный TranslationsMap для mergeTranslations.
 */
export function translationsInputSchema(
  fieldWhitelist: readonly string[],
  locales: readonly string[],
  options: TranslationsSchemaOptions = {},
): z.ZodType<Record<string, Record<string, string>>> {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const fieldSchema = z.string().max(maxLength).optional();

  const perLocaleShape: Record<string, z.ZodTypeAny> = {};
  for (const field of fieldWhitelist) {
    perLocaleShape[field] = fieldSchema;
  }
  const perLocale = z.object(perLocaleShape); // strip: неизвестные поля отсекаются

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const locale of locales) {
    shape[locale] = perLocale.optional();
  }

  return z.object(shape) as unknown as z.ZodType<Record<string, Record<string, string>>>;
}

/**
 * Мержит патч переводов в существующий оверлей ДЛЯ ОДНОГО языка. Переводы
 * остальных языков сохраняются нетронутыми. Возвращает НОВЫЙ объект.
 */
export function mergeTranslations(
  existing: TranslationsMap | null | undefined,
  locale: string,
  patch: Record<string, unknown>,
): TranslationsMap {
  const next: TranslationsMap = existing ? { ...existing } : {};
  const current = next[locale] ?? {};
  next[locale] = { ...current, ...patch };
  return next;
}
