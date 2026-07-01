/**
 * Слой чтения CMS (docs/11 §5.1.3).
 *
 * Только SELECT через `sql` (tagged templates → параметризация, анти-SQLi).
 * Никаких мутаций здесь — они в actions.ts (5.C-2) через defineAction.
 *
 * Маппинг row(snake_case)→domain(camelCase) вынесен в чистые функции map*,
 * экспортируемые для юнит-тестов (БД не нужна). Образец lib/catalog/repository.ts.
 */

import { sql } from '@/lib/db/client';
import { escapeLike } from '@/lib/db/like';
import type {
  CmsPage,
  CmsPageListRow,
  CmsPageStatus,
  CmsPageWithSections,
  CmsSection,
  CmsSectionType,
  SitemapChangefreq,
} from './types';

// =============================================================================
// Чистые мапперы row→domain (тестируемы без БД).
// =============================================================================

function asDate(v: any): Date {
  return v instanceof Date ? v : new Date(v);
}

function asNullableDate(v: any): Date | null {
  if (v === null || v === undefined) return null;
  return asDate(v);
}

function asContent(v: any): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Маппер строки cms_pages → доменная CmsPage. */
export function mapCmsPage(row: any): CmsPage {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status as CmsPageStatus,
    publishedAt: asNullableDate(row.published_at),
    seoTitle: row.seo_title ?? null,
    seoDescription: row.seo_description ?? null,
    ogTitle: row.og_title ?? null,
    ogDescription: row.og_description ?? null,
    ogImageUrl: row.og_image_url ?? null,
    canonicalUrl: row.canonical_url ?? null,
    noindex: Boolean(row.noindex),
    sitemapPriority:
      row.sitemap_priority === null || row.sitemap_priority === undefined
        ? null
        : Number(row.sitemap_priority),
    sitemapChangefreq: (row.sitemap_changefreq ?? null) as SitemapChangefreq | null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** Маппер строки cms_page_sections → доменная CmsSection. */
export function mapCmsSection(row: any): CmsSection {
  return {
    id: row.id,
    pageId: row.page_id,
    sectionKey: row.section_key,
    type: row.type as CmsSectionType,
    content: asContent(row.content),
    displayOrder:
      row.display_order === null || row.display_order === undefined
        ? 0
        : Number(row.display_order),
    enabled: Boolean(row.enabled),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** Маппер строки списка (минимальный набор полей для таблицы /admin/cms). */
export function mapCmsPageListRow(row: any): CmsPageListRow {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status as CmsPageStatus,
    publishedAt: asNullableDate(row.published_at),
    updatedAt: asDate(row.updated_at),
  };
}

// =============================================================================
// SELECT-запросы (нужна живая БД; в тестах — мапперы выше или skipIf).
// =============================================================================

export interface CmsPageListFilter {
  search?: string;
  status?: CmsPageStatus;
  page: number;
  pageSize: number;
}

/**
 * Список страниц с фильтром/поиском/пагинацией (образец listProducts).
 * Поиск — ILIKE по title/slug. Все условия параметризованы.
 */
export async function listCmsPages(
  f: CmsPageListFilter,
): Promise<{ rows: CmsPageListRow[]; total: number }> {
  const page = Math.max(1, Math.floor(f.page));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize)));
  const offset = (page - 1) * pageSize;
  const searchTerm = f.search?.trim() ? `%${escapeLike(f.search.trim())}%` : null;

  const where = sql`
    WHERE (${searchTerm}::text IS NULL OR title ILIKE ${searchTerm} OR slug::text ILIKE ${searchTerm})
      AND (${f.status ?? null}::text IS NULL OR status = ${f.status ?? null})
  `;

  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, title, status, published_at, updated_at
    FROM cms_pages
    ${where}
    ORDER BY updated_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const totalRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM cms_pages ${where}
  `;

  return {
    rows: rows.map(mapCmsPageListRow),
    total: Number(totalRows[0]?.count ?? 0),
  };
}

/** Страница по id со связанными секциями (по display_order). Null, если нет. */
export async function getCmsPageById(
  id: string,
): Promise<CmsPageWithSections | null> {
  const pageRows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, title, status, published_at,
           seo_title, seo_description, og_title, og_description,
           og_image_url, canonical_url, noindex,
           sitemap_priority, sitemap_changefreq,
           created_by, updated_by, created_at, updated_at
    FROM cms_pages WHERE id = ${id} LIMIT 1
  `;
  if (pageRows.length === 0) return null;

  const sectionRows = await sql<Record<string, unknown>[]>`
    SELECT id, page_id, section_key, type, content, display_order, enabled,
           created_at, updated_at
    FROM cms_page_sections
    WHERE page_id = ${id}
    ORDER BY display_order ASC, created_at ASC
  `;

  return {
    ...mapCmsPage(pageRows[0]),
    sections: sectionRows.map(mapCmsSection),
  };
}

/**
 * Список опубликованных страниц (для витрины — навигация: slug/title/SEO).
 * Только status='published'; без секций (их тянет getPublishedCmsPageBySlug).
 * Сортировка по published_at DESC (свежие выше).
 */
export async function listPublishedCmsPages(): Promise<CmsPage[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, title, status, published_at,
           seo_title, seo_description, og_title, og_description,
           og_image_url, canonical_url, noindex,
           sitemap_priority, sitemap_changefreq,
           created_by, updated_by, created_at, updated_at
    FROM cms_pages
    WHERE status = 'published'
    ORDER BY published_at DESC NULLS LAST, title ASC
  `;
  return rows.map(mapCmsPage);
}

/**
 * Опубликованная страница по slug со связанными секциями (для витрины).
 * Только status='published'. Null, если нет/не опубликована.
 */
export async function getPublishedCmsPageBySlug(
  slug: string,
): Promise<CmsPageWithSections | null> {
  const pageRows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, title, status, published_at,
           seo_title, seo_description, og_title, og_description,
           og_image_url, canonical_url, noindex,
           sitemap_priority, sitemap_changefreq,
           created_by, updated_by, created_at, updated_at
    FROM cms_pages
    WHERE slug = ${slug} AND status = 'published'
    LIMIT 1
  `;
  if (pageRows.length === 0) return null;

  const pageId = (pageRows[0] as any).id as string;
  const sectionRows = await sql<Record<string, unknown>[]>`
    SELECT id, page_id, section_key, type, content, display_order, enabled,
           created_at, updated_at
    FROM cms_page_sections
    WHERE page_id = ${pageId} AND enabled = true
    ORDER BY display_order ASC, created_at ASC
  `;

  return {
    ...mapCmsPage(pageRows[0]),
    sections: sectionRows.map(mapCmsSection),
  };
}
