/**
 * i18n-слой Admik (ADR-i18n, docs/24 §1) — фундамент мультиязычного контента.
 * Стратегия jsonb-оверлея: база = язык по умолчанию, оверлей translations = en/fr.
 * Реэкспорт публичного API домена.
 */

export type {
  Locale,
  LocaleConfig,
  TranslationsMap,
  TranslatableFields,
} from './types';

export {
  DEFAULT_LOCALE_CONFIG,
  normalizeLocale,
  parseLocaleConfig,
  resolveRequestLocale,
  getLocaleConfig,
  type LocaleConfigReader,
} from './config';

export {
  isNonEmptyValue,
  withFallback,
  localizeField,
  localizeRow,
  localizeStructured,
} from './resolve';

export {
  translationsInputSchema,
  mergeTranslations,
  type TranslationsSchemaOptions,
} from './schemas';

export {
  PRODUCT_TR_FIELDS,
  PRODUCT_LIST_TR_FIELDS,
  BRAND_TR_FIELDS,
  DESIGNER_TR_FIELDS,
  CATEGORY_TR_FIELDS,
  VARIANT_TR_FIELDS,
  ATTRIBUTE_TR_FIELDS,
  ATTRIBUTE_VALUE_TR_FIELDS,
  CMS_PAGE_TR_FIELDS,
  PRODUCT_BLOCK_TR_FIELDS,
} from './fields';

export {
  resolveTranslationsUpdate,
  translationsBlockSchema,
  type TranslationsUpdateResult,
} from './write';

export {
  LEGACY_KEY_ALIASES,
  normalizeLegacyTranslationKeys,
  toSnakeCase,
  type NormalizeLegacyKeysResult,
} from './legacy-keys';

export {
  computeCoverage,
  type FieldCoverage,
  type LocaleCoverage,
  type CoverageResult,
} from './coverage';
