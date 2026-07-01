/**
 * Zod-схемы CMS (docs/11 §5.1.1, §5.1.3, инвариант 5.1).
 *
 * Обычный модуль (НЕ 'use server') — содержит только схемы/типы; переиспользуется
 * в UI-формах и внутри Server Actions (один источник правды о форме входа).
 *
 * Ключевой инвариант — `CmsSectionContentSchema`: дискриминированный union по полю
 * `type`. Каждая секция имеет строго типизированный `content`; неизвестные поля
 * отбрасываются Zod (`.strip()` по умолчанию), неизвестный `type` отвергается.
 * `products_grid` хранит ТОЛЬКО slug-фильтры (без FK на каталог) — модули cms и
 * catalog независимы (инвариант 5.1); refine проверяет согласованность mode↔поля.
 *
 * Rich-text-поля (`html`, faq.a) валидируются здесь лишь как строки; СЕРВЕРНАЯ
 * санитизация (lib/cms/sanitize.ts) применяется в Server Action перед записью.
 */

import { z } from 'zod';

import {
  seoTitleSchema,
  seoDescriptionSchema,
  ogTitleSchema,
  ogDescriptionSchema,
  canonicalUrlSchema,
  noindexSchema,
} from '@/lib/seo/schemas';
import { slugSchema } from '@/lib/catalog/schemas';
import { CMS_PAGE_STATUSES, SITEMAP_CHANGEFREQS } from './types';

// -----------------------------------------------------------------------------
// Переиспользуемые примитивы.
// -----------------------------------------------------------------------------

/** UUID-идентификатор. */
export const uuidSchema = z.string().uuid();

/** Непустой человекочитаемый текст до 255 символов (заголовки/подписи). */
const shortTextSchema = z.string().trim().min(1).max(255);

/** Произвольная rich-text строка (HTML). Санитизация — на сервере, не здесь. */
const richTextSchema = z.string().max(50000);

/** Ключ объекта в хранилище (S3/MinIO). НЕ URL — URL собирает storage.publicUrl. */
const imageKeySchema = z.string().trim().min(1).max(512);

/** Href: относительный путь или абсолютный URL (детальная санитизация — на рендере). */
const hrefSchema = z.string().trim().min(1).max(2048);

/** section_key — стабильный машинный ключ секции в пределах страницы. */
export const sectionKeySchema = z.string().trim().min(1).max(100);

// -----------------------------------------------------------------------------
// Контракты content по type (§5.1.1) — члены дискриминированного union.
// -----------------------------------------------------------------------------

const heroContentSchema = z.object({
  type: z.literal('hero'),
  title: shortTextSchema,
  subtitle: shortTextSchema.optional(),
  html: richTextSchema.optional(),
  imageKey: imageKeySchema.optional(),
  ctaLabel: shortTextSchema.optional(),
  ctaHref: hrefSchema.optional(),
});

const textContentSchema = z.object({
  type: z.literal('text'),
  html: richTextSchema,
});

const bannerContentSchema = z.object({
  type: z.literal('banner'),
  imageKey: imageKeySchema,
  href: hrefSchema.optional(),
  alt: z.string().trim().max(255).optional(),
});

/**
 * products_grid — подборка товаров по slug-фильтру (БЕЗ FK на каталог).
 * mode определяет, какое поле-идентификатор обязательно (refine ниже, на уровне
 * объединённого union — z.discriminatedUnion принимает только «чистые» ZodObject,
 * поэтому superRefine навешан после union, а не на этот член). Несуществующий
 * slug на уровне схемы валиден (формат-строка) — отсутствие товара обрабатывает
 * витрина через /products, а не валидатор (инвариант 5.1).
 */
const productsGridContentSchema = z.object({
  type: z.literal('products_grid'),
  mode: z.enum(['slugs', 'category', 'brand']),
  slugs: z.array(slugSchema).optional(),
  categorySlug: slugSchema.optional(),
  brandSlug: slugSchema.optional(),
  limit: z.number().int().min(1).max(48).default(12),
  title: shortTextSchema.optional(),
});

const faqContentSchema = z.object({
  type: z.literal('faq'),
  items: z
    .array(
      z.object({
        q: shortTextSchema,
        a: richTextSchema,
      }),
    )
    .min(1),
});

const ctaContentSchema = z.object({
  type: z.literal('cta'),
  title: shortTextSchema,
  html: richTextSchema.optional(),
  buttonLabel: shortTextSchema,
  buttonHref: hrefSchema,
});

const galleryContentSchema = z.object({
  type: z.literal('gallery'),
  images: z
    .array(
      z.object({
        imageKey: imageKeySchema,
        alt: z.string().trim().max(255).optional(),
      }),
    )
    .min(1),
});

/**
 * Базовый дискриминированный union по `type` (все 7 членов — «чистые» ZodObject).
 * Неизвестный `type` отвергается; чужие поля для типа отбрасываются (strip).
 */
const cmsSectionContentBaseSchema = z.discriminatedUnion('type', [
  heroContentSchema,
  textContentSchema,
  bannerContentSchema,
  productsGridContentSchema,
  faqContentSchema,
  ctaContentSchema,
  galleryContentSchema,
]);

/**
 * Итоговая схема контента секции: базовый дискриминированный union + кросс-полевой
 * refine для products_grid (mode ↔ обязательное поле-идентификатор). superRefine
 * навешан здесь (после union), т.к. z.discriminatedUnion не принимает ZodEffects-члены.
 */
export const CmsSectionContentSchema = cmsSectionContentBaseSchema.superRefine(
  (val, ctx) => {
    if (val.type !== 'products_grid') return;
    if (val.mode === 'slugs') {
      if (!val.slugs || val.slugs.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slugs'],
          message: "mode='slugs' требует непустой список slugs",
        });
      }
    } else if (val.mode === 'category') {
      if (!val.categorySlug) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['categorySlug'],
          message: "mode='category' требует categorySlug",
        });
      }
    } else if (val.mode === 'brand') {
      if (!val.brandSlug) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['brandSlug'],
          message: "mode='brand' требует brandSlug",
        });
      }
    }
  },
);

// -----------------------------------------------------------------------------
// Схемы секции и страницы.
// -----------------------------------------------------------------------------

/** Вход для upsert секции (Server Action upsertCmsSection). */
export const CmsSectionInputSchema = z.object({
  pageId: uuidSchema,
  sectionKey: sectionKeySchema,
  content: CmsSectionContentSchema,
  displayOrder: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

/** Reorder секций страницы (Server Action reorderCmsSections). */
export const CmsSectionReorderSchema = z.object({
  pageId: uuidSchema,
  order: z
    .array(
      z.object({
        id: uuidSchema,
        displayOrder: z.number().int().min(0),
      }),
    )
    .min(1),
});

/** Переключение видимости секции (Server Action setCmsSectionEnabled). */
export const CmsSectionSetEnabledSchema = z.object({
  id: uuidSchema,
  enabled: z.boolean(),
});

/** Идентификатор секции (Server Action deleteCmsSection). */
export const CmsSectionIdSchema = z.object({
  id: uuidSchema,
});

/** Идентификатор страницы (delete/publish/unpublish). */
export const CmsPageIdSchema = z.object({
  id: uuidSchema,
});

/** SEO/sitemap-поля страницы — общий фрагмент для create/update. */
const sitemapPrioritySchema = z.number().min(0).max(1).optional();
const sitemapChangefreqSchema = z.enum(
  SITEMAP_CHANGEFREQS as unknown as [string, ...string[]],
).optional();

const pageSeoFields = {
  seoTitle: seoTitleSchema,
  seoDescription: seoDescriptionSchema,
  // OG-текст страницы — те же примитивы, что у каталога (C18, docs/20 §C18).
  ogTitle: ogTitleSchema,
  ogDescription: ogDescriptionSchema,
  ogImageUrl: z.string().trim().max(2048).optional(),
  canonicalUrl: canonicalUrlSchema,
  noindex: noindexSchema,
  sitemapPriority: sitemapPrioritySchema,
  sitemapChangefreq: sitemapChangefreqSchema,
};

/** Статус страницы — триада из CHECK БД (для фильтра списка). */
export const cmsPageStatusSchema = z.enum(
  CMS_PAGE_STATUSES as unknown as [string, ...string[]],
);

/**
 * Редактируемый статус для create/update — ТОЛЬКО 'draft'/'archived' (баг B
 * волны 5). Публикация ('published') нарушает инвариант миграций 0022/0023, если
 * выполняется через обычный UPDATE: published_at остаётся NULL и не пишется снимок
 * в cms_page_revisions. Корректную публикацию делает ТОЛЬКО publishCmsPage
 * (транзакция status + published_at=COALESCE(...,now()) + ревизия). Снятие с
 * публикации / архивирование через 'draft'/'archived' безопасно — published_at
 * остаётся как историческая метка.
 */
export const cmsPageEditableStatusSchema = z.enum(['draft', 'archived']);

/** Создание страницы: title обязателен, slug опционален (→ slugify(title)). */
export const CmsPageCreateSchema = z.object({
  title: shortTextSchema,
  slug: slugSchema.optional(),
  status: cmsPageEditableStatusSchema.optional(),
  ...pageSeoFields,
});

/** Обновление страницы: id обязателен, остальные поля частичны. */
export const CmsPageUpdateSchema = z.object({
  id: uuidSchema,
  title: shortTextSchema.optional(),
  slug: slugSchema.optional(),
  status: cmsPageEditableStatusSchema.optional(),
  ...pageSeoFields,
});

/** Фильтр списка страниц (поиск/статус/пагинация — образец listProducts). */
export const CmsPageListFilterSchema = z.object({
  search: z.string().trim().optional(),
  status: cmsPageStatusSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(20),
});

/**
 * Загрузка изображения CMS (ADR-018). Байты приходят Buffer (Server Action
 * извлекает из FormData); тип/размер проверяются validateUpload по magic-bytes.
 * Действие ВОЗВРАЩАЕТ S3-ключ (CMS-секции хранят imageKey, не URL — ADR-012).
 */
export const CmsImageUploadSchema = z.object({
  filename: z.string().max(255).optional().default('upload'),
  bytes: z.instanceof(Buffer),
});
export type CmsImageUploadInput = z.infer<typeof CmsImageUploadSchema>;

export type CmsSectionInput = z.infer<typeof CmsSectionInputSchema>;
export type CmsSectionReorderInput = z.infer<typeof CmsSectionReorderSchema>;
export type CmsPageCreateInput = z.infer<typeof CmsPageCreateSchema>;
export type CmsPageUpdateInput = z.infer<typeof CmsPageUpdateSchema>;
export type CmsPageListFilter = z.infer<typeof CmsPageListFilterSchema>;
