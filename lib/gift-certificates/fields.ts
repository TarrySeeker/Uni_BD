/**
 * Whitelist переводимых полей подарочного сертификата (ADR-i18n, docs/24 §1, §5).
 * ЕДИНЫЙ источник правды для read-path (storefront DTO — 4b) и write-path
 * (admin actions). Симметрия обязательна: что локализуется на выдаче, то и
 * принимается на входе; всё прочее молча отсекается translationsInputSchema.
 *
 * code/name — служебные, НЕ переводимы. Публичны и переводимы только
 * description (описание) и terms (условия использования).
 */
export const GIFT_TR_FIELDS = ['description', 'terms'] as const;
