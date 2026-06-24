/**
 * Доменные типы CMS (docs/11 §5.1.1).
 *
 * Типы прикладного уровня (camelCase), отображающие строки таблиц cms_pages /
 * cms_page_sections. Маппинг row(snake_case)→domain(camelCase) — в repository.ts
 * (функции map*). Образец — lib/catalog/types.ts.
 */

import type { z } from 'zod';
import type { CmsSectionContentSchema } from './schemas';

// -----------------------------------------------------------------------------
// Перечисления / литеральные типы (соответствуют CHECK-ограничениям в БД).
// -----------------------------------------------------------------------------

/** Жизненный цикл страницы (cms_pages.status). Триада как у products. */
export type CmsPageStatus = 'draft' | 'published' | 'archived';
export const CMS_PAGE_STATUSES: readonly CmsPageStatus[] = [
  'draft',
  'published',
  'archived',
] as const;

/** Тип секции (cms_page_sections.type) — дискриминатор Zod-валидации content. */
export type CmsSectionType =
  | 'hero'
  | 'text'
  | 'banner'
  | 'products_grid'
  | 'faq'
  | 'cta'
  | 'gallery';
export const CMS_SECTION_TYPES: readonly CmsSectionType[] = [
  'hero',
  'text',
  'banner',
  'products_grid',
  'faq',
  'cta',
  'gallery',
] as const;

/** Частота обновления для sitemap (cms_pages.sitemap_changefreq). */
export type SitemapChangefreq =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';
export const SITEMAP_CHANGEFREQS: readonly SitemapChangefreq[] = [
  'always',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'never',
] as const;

/** Типизированный content секции — вывод дискриминированного union. */
export type CmsSectionContent = z.infer<typeof CmsSectionContentSchema>;

// -----------------------------------------------------------------------------
// Сущности.
// -----------------------------------------------------------------------------

/** Контент-страница (cms_pages). */
export interface CmsPage {
  id: string;
  slug: string;
  title: string;
  status: CmsPageStatus;
  publishedAt: Date | null;
  // SEO/sitemap:
  seoTitle: string | null;
  seoDescription: string | null;
  ogImageUrl: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  sitemapPriority: number | null;
  sitemapChangefreq: SitemapChangefreq | null;
  // audit:
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Секция страницы (cms_page_sections). */
export interface CmsSection {
  id: string;
  pageId: string;
  sectionKey: string;
  type: CmsSectionType;
  /** Сырой JSONB из БД (валидируется CmsSectionContentSchema при записи/отдаче). */
  content: Record<string, unknown>;
  displayOrder: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Страница со связанными секциями (для админ-карточки / витрины). */
export interface CmsPageWithSections extends CmsPage {
  sections: CmsSection[];
}

/** Строка списка страниц (для таблицы /admin/cms). */
export interface CmsPageListRow {
  id: string;
  slug: string;
  title: string;
  status: CmsPageStatus;
  publishedAt: Date | null;
  updatedAt: Date;
}
