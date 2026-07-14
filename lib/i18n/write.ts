/**
 * Write-path переводов для admin Server Actions (ADR-i18n, docs/24 §1, инкремент 2b).
 *
 * Симметрия с read-path (инкремент 2a): применяется ТОТ ЖЕ whitelist полей
 * (lib/i18n/fields), что и на выдаче. Базовый язык (defaultLocale = ru) живёт в
 * обычных колонках и НИКОГДА не дублируется в оверлей — поэтому overlay-схема
 * строится только по НЕ-дефолтным включённым языкам магазина.
 *
 * resolveTranslationsUpdate — ЧИСТАЯ функция (без БД/Next): принимает уже
 * загруженную конфигурацию языков, поэтому легко тестируется. Server Action грузит
 * config через getLocaleConfig() и передаёт сюда.
 */

import { z } from 'zod';

import { translationsInputSchema, mergeTranslations } from './schemas';
import type { LocaleConfig, TranslationsMap } from './types';

/**
 * Схема блока переводов на уровне Server-Action-входа: `{ [locale]: { [field]: string } }`.
 * Здесь — только грубая форма (карта карт строк); тонкая фильтрация whitelist-полей
 * и включённых языков делается в resolveTranslationsUpdate (нужен runtime-конфиг
 * языков, недоступный на этапе статической Zod-схемы). Опционально: отсутствие блока
 * означает «переводы не трогаем».
 */
export const translationsBlockSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .optional();

/** Результат применения патча переводов к существующему оверлею строки. */
export interface TranslationsUpdateResult {
  /** true, если во входе был хотя бы один валидный (whitelist × включённый язык) перевод. */
  provided: boolean;
  /** Итоговый оверлей translations (существующий + патч; иммутабельно). */
  value: TranslationsMap;
}

/**
 * Резолвит новое значение колонки translations из входного блока формы.
 *
 * - Отсекает не-whitelist поля и не-включённые языки (translationsInputSchema).
 * - Отсекает defaultLocale: база (ru) пишется в обычные колонки, не в оверлей.
 * - Мержит КАЖДЫЙ переданный язык в существующий оверлей через mergeTranslations
 *   (перевод другого языка не затирается; исходный объект не мутируется).
 *
 * provided=false, когда блока нет или после фильтрации не осталось ни одного
 * валидного языка/поля — тогда Server Action НЕ трогает колонку translations
 * (обратная совместимость: правки базовых колонок идут независимо).
 */
export function resolveTranslationsUpdate(
  whitelist: readonly string[],
  input: unknown,
  existing: TranslationsMap | null | undefined,
  config: LocaleConfig,
): TranslationsUpdateResult {
  const base: TranslationsMap = existing ? { ...existing } : {};
  if (input == null || typeof input !== 'object') {
    return { provided: false, value: base };
  }

  // Overlay-языки = включённые минус дефолтный (база не дублируется в оверлей).
  const overlayLocales = config.locales.filter((l) => l !== config.defaultLocale);
  const parsed = translationsInputSchema(whitelist, overlayLocales).safeParse(input);
  if (!parsed.success) {
    // Нестроковые значения и т.п. — на write-path трактуем как «нет валидных
    // переводов» (грубую форму уже проверил translationsBlockSchema во входной
    // Zod-схеме Action; сюда невалид практически не доходит).
    return { provided: false, value: base };
  }

  let value = base;
  let provided = false;
  for (const [locale, fields] of Object.entries(parsed.data)) {
    if (!fields) continue;
    if (Object.keys(fields).length === 0) continue;
    value = mergeTranslations(value, locale, fields);
    provided = true;
  }
  return { provided, value };
}
