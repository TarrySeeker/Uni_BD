/**
 * Whitelist переводимых полей новости (ADR-i18n, docs/24 §1, §3) — ЕДИНЫЙ источник
 * правды для read-path (storefront news-dto), write-path (admin actions) и панели
 * LocaleTabs на форме. Симметрия обязательна: что локализуется на выдаче, то и
 * принимается на входе; всё прочее молча отсекается translationsInputSchema.
 *
 * Ключи совпадают с camelCase-полями доменного объекта и ключами оверлея translations.
 * НЕ переводимо: slug, cover/og-ключи, published_at, status, sort_order, noindex, даты.
 */
export const NEWS_TRANSLATABLE_FIELDS = [
  'title',
  'groupLabel',
  'excerpt',
  'body',
  'seoTitle',
  'seoDescription',
  'ogTitle',
  'ogDescription',
] as const;
