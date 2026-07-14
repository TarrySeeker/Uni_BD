/**
 * Типы i18n-слоя (ADR-i18n, docs/24 §1).
 *
 * Стратегия — jsonb-оверлей: базовые колонки строки = канон языка по умолчанию
 * (для carre = ru), не-дефолтные языки живут в колонке `translations` вида
 *   { "<locale>": { "<field>": "<value>" } }.
 * База (ru) в оверлей не дублируется.
 *
 * Locale — намеренно `string` (не enum): набор языков задаётся per-shop в
 * shop_settings.i18n, а не хардкодом в типе. Валидация членства — в config.ts.
 */

/** Код языка (BCP-47-подобный тег, напр. 'ru' | 'en' | 'fr'). Нормализуется в нижний регистр. */
export type Locale = string;

/** Конфигурация языков магазина: язык по умолчанию + список включённых. */
export interface LocaleConfig {
  readonly defaultLocale: Locale;
  readonly locales: readonly Locale[];
}

/** Сырой оверлей переводов строки: locale → { field → value }. */
export type TranslationsMap = Record<string, Record<string, unknown>>;

/** Whitelist переводимых полей сущности (единый источник для Zod/резолва/покрытия). */
export type TranslatableFields = readonly string[];
