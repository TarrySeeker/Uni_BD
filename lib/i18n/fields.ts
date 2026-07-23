/**
 * Whitelist переводимых полей по сущности (ADR-i18n, docs/24 §1) — ЕДИНЫЙ источник
 * правды для read-path (storefront DTO, инкремент 2a) и write-path (admin actions,
 * инкремент 2b). Симметрия обязательна: что локализуется на выдаче, то и принимается
 * на входе; всё остальное молча отсекается translationsInputSchema.
 *
 * Ключи совпадают с camelCase-полями доменного объекта и ключами оверлея translations.
 */

/** Товар (карточка): name/description + SEO/OG-текст. */
export const PRODUCT_TR_FIELDS = [
  'name',
  'description',
  'seoTitle',
  'seoDescription',
  'ogTitle',
  'ogDescription',
] as const;

/** Строка списка товаров: только name (description/SEO в списке не отдаются). */
export const PRODUCT_LIST_TR_FIELDS = ['name'] as const;

/** Бренд: name/description + SEO/OG-текст. */
export const BRAND_TR_FIELDS = [
  'name',
  'description',
  'seoTitle',
  'seoDescription',
  'ogTitle',
  'ogDescription',
] as const;

/** Дизайнер (персона): name/description/country (§9, ADR §4.4). SEO не переводим. */
export const DESIGNER_TR_FIELDS = ['name', 'description', 'country'] as const;

/** Категория: name/description + SEO/OG-текст. */
export const CATEGORY_TR_FIELDS = [
  'name',
  'description',
  'seoTitle',
  'seoDescription',
  'ogTitle',
  'ogDescription',
] as const;

/** Вариант: только name. */
export const VARIANT_TR_FIELDS = ['name'] as const;

/**
 * Структурная секция карточки товара (product_blocks, §9). Плоские переводимые
 * поля — title/blockquot/body; табы переводятся СТРУКТУРНО (translations[locale].tabs,
 * localizeStructured), поэтому в плоский whitelist НЕ входят. Непереводимо:
 * type/author_designer_id/image_key/sort.
 */
export const PRODUCT_BLOCK_TR_FIELDS = ['title', 'blockquot', 'body'] as const;

/** CMS-страница: заголовок + SEO/OG-текст (структурный контент секций — отдельно). */
export const CMS_PAGE_TR_FIELDS = [
  'title',
  'seoTitle',
  'seoDescription',
  'ogTitle',
  'ogDescription',
] as const;

/**
 * ТЕЛО CMS-страницы — секции (cms_page_sections), whitelist ПО ТИПУ секции (T5).
 *
 * Контент секции структурный, поэтому оверлей — не плоская карта строк, а ПАТЧ
 * content: read-path (lib/storefront/cms-dto) deep-merge'ит translations[locale]
 * поверх базового content через localizeStructured. Ключи ниже — верхнеуровневые
 * ключи content; `items` (faq) и `images` (gallery) переводятся структурно —
 * по индексу элемента (q/a и alt соответственно), см. lib/cms/section-i18n.
 *
 * Непереводимо принципиально: дискриминатор type, ссылки (ctaHref/href/buttonHref),
 * ключи хранилища (imageKey) и машинный фильтр подборки (mode/limit/slugs/*Slug) —
 * это идентификаторы, а не текст; их перевод ломал бы ссылки и выдачу товаров.
 */
export const CMS_SECTION_TR_FIELDS: Record<string, readonly string[]> = {
  hero: ['title', 'subtitle', 'html', 'ctaLabel'],
  text: ['html'],
  banner: ['alt'],
  products_grid: ['title'],
  faq: ['items'],
  cta: ['title', 'html', 'buttonLabel'],
  gallery: ['images'],
};
