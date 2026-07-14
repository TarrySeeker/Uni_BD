/**
 * Слой чтения/записи новостей (docs/24 §3).
 *
 * Только параметризованный `sql` (tagged templates → анти-SQLi). Мутации —
 * insert/update/updateStatus/delete (вызываются из actions.ts через defineAction).
 * Маппинг row(snake_case)→domain(camelCase) вынесен в чистые функции map*,
 * экспортируемые для юнит-тестов (БД не нужна). Образец lib/cms/repository.ts.
 *
 * translations тянется СЫРЫМ (locale-агностично); резолв переводимых полей — на
 * границе (storefront news-dto по ctx.locale; admin-форма по активной вкладке).
 */

import { sql } from '@/lib/db/client';
import { escapeLike } from '@/lib/db/like';
import type { TranslationsMap } from '@/lib/i18n';

import type {
  NewsArticle,
  NewsListRow,
  NewsStatus,
} from './types';

// =============================================================================
// Чистые мапперы row→domain (тестируемы без БД).
// =============================================================================

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}
function asNullableDate(v: unknown): Date | null {
  return v == null ? null : asDate(v);
}

/** Сырой jsonb-оверлей → TranslationsMap. Не-объект/массив/NULL → {}. */
function asTranslations(v: unknown): TranslationsMap {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as TranslationsMap;
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as TranslationsMap)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function asInt(v: unknown): number {
  return v == null ? 0 : Number(v);
}

/** Маппер строки news → доменная NewsArticle (полная запись, с body). */
export function mapNews(row: Record<string, unknown>): NewsArticle {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    groupLabel: row.group_label != null ? String(row.group_label) : null,
    excerpt: row.excerpt != null ? String(row.excerpt) : null,
    body: row.body != null ? String(row.body) : null,
    coverImageKey: row.cover_image_key != null ? String(row.cover_image_key) : null,
    status: row.status as NewsStatus,
    publishedAt: asNullableDate(row.published_at),
    sortOrder: asInt(row.sort_order),
    seoTitle: row.seo_title != null ? String(row.seo_title) : null,
    seoDescription: row.seo_description != null ? String(row.seo_description) : null,
    ogTitle: row.og_title != null ? String(row.og_title) : null,
    ogDescription: row.og_description != null ? String(row.og_description) : null,
    ogImageKey: row.og_image_key != null ? String(row.og_image_key) : null,
    noindex: Boolean(row.noindex),
    canonicalUrl: row.canonical_url != null ? String(row.canonical_url) : null,
    translations: asTranslations(row.translations),
    createdBy: row.created_by != null ? String(row.created_by) : null,
    updatedBy: row.updated_by != null ? String(row.updated_by) : null,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** Маппер строки списка/ленты (без body). */
export function mapNewsListRow(row: Record<string, unknown>): NewsListRow {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    groupLabel: row.group_label != null ? String(row.group_label) : null,
    excerpt: row.excerpt != null ? String(row.excerpt) : null,
    coverImageKey: row.cover_image_key != null ? String(row.cover_image_key) : null,
    status: row.status as NewsStatus,
    publishedAt: asNullableDate(row.published_at),
    sortOrder: asInt(row.sort_order),
    seoTitle: row.seo_title != null ? String(row.seo_title) : null,
    seoDescription: row.seo_description != null ? String(row.seo_description) : null,
    ogTitle: row.og_title != null ? String(row.og_title) : null,
    ogDescription: row.og_description != null ? String(row.og_description) : null,
    ogImageKey: row.og_image_key != null ? String(row.og_image_key) : null,
    noindex: Boolean(row.noindex),
    canonicalUrl: row.canonical_url != null ? String(row.canonical_url) : null,
    translations: asTranslations(row.translations),
    updatedAt: asDate(row.updated_at),
  };
}

/**
 * Список колонок как sql-фрагмент. ФУНКЦИЯ (не top-level константа): `sql\`...\``
 * дёргает ленивый клиент БД; вычисление на импорте упало бы без DATABASE_URL.
 */
function newsCols() {
  return sql`
    id, slug, title, group_label, excerpt, body, cover_image_key, status,
    published_at, sort_order, seo_title, seo_description, og_title, og_description,
    og_image_key, noindex, canonical_url, translations,
    created_by, updated_by, created_at, updated_at
  `;
}

/** Колонки строки списка/ленты (без body). */
function newsListCols() {
  return sql`
    id, slug, title, group_label, excerpt, cover_image_key, status,
    published_at, sort_order, seo_title, seo_description, og_title, og_description,
    og_image_key, noindex, canonical_url, translations, updated_at
  `;
}

// =============================================================================
// Чтения (нужна живая БД; в тестах — мапперы выше или skipIf).
// =============================================================================

export interface NewsListFilter {
  search?: string;
  status?: NewsStatus;
  page: number;
  pageSize: number;
}

/**
 * Список новостей с фильтром/поиском/пагинацией для админки (образец listCmsPages).
 * Поиск — ILIKE по title/slug/group_label. Все условия параметризованы.
 */
export async function listNews(
  f: NewsListFilter,
): Promise<{ rows: NewsListRow[]; total: number }> {
  const page = Math.max(1, Math.floor(f.page));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize)));
  const offset = (page - 1) * pageSize;
  const searchTerm = f.search?.trim() ? `%${escapeLike(f.search.trim())}%` : null;

  const where = sql`
    WHERE (${searchTerm}::text IS NULL
           OR title ILIKE ${searchTerm}
           OR slug::text ILIKE ${searchTerm}
           OR group_label ILIKE ${searchTerm})
      AND (${f.status ?? null}::text IS NULL OR status = ${f.status ?? null})
  `;

  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${newsListCols()}
    FROM news
    ${where}
    ORDER BY sort_order ASC, published_at DESC NULLS LAST, created_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const totalRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM news ${where}
  `;

  return {
    rows: rows.map(mapNewsListRow),
    total: Number(totalRows[0]?.count ?? 0),
  };
}

/** Общее число новостей (для «Всего: N» / пагинации админки). */
export async function countNews(status?: NewsStatus): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM news
    WHERE (${status ?? null}::text IS NULL OR status = ${status ?? null})
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Новость по id (полная запись). null — не найдена. */
export async function getNewsById(id: string): Promise<NewsArticle | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${newsCols()} FROM news WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapNews(rows[0]) : null;
}

/** Новость по slug (любой статус, для админки). null — не найдена. */
export async function getNewsBySlug(slug: string): Promise<NewsArticle | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${newsCols()} FROM news WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ? mapNews(rows[0]) : null;
}

export interface PublishedNewsFilter {
  /** Фильтр по рубрике (group_label), опц. */
  group?: string;
  limit: number;
  offset: number;
}

/**
 * Витринная лента: ТОЛЬКО status='published', ручной порядок → свежие выше.
 * Пагинация limit/offset. Без body (лёгкая строка списка).
 */
export async function getPublishedNews(
  f: PublishedNewsFilter,
): Promise<{ rows: NewsListRow[]; total: number }> {
  const limit = Math.min(50, Math.max(1, Math.floor(f.limit)));
  const offset = Math.max(0, Math.floor(f.offset));
  const group = f.group?.trim() ? f.group.trim() : null;

  const where = sql`
    WHERE status = 'published'
      AND (${group}::text IS NULL OR group_label = ${group})
  `;

  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${newsListCols()}
    FROM news
    ${where}
    ORDER BY sort_order ASC, published_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const totalRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM news ${where}
  `;

  return {
    rows: rows.map(mapNewsListRow),
    total: Number(totalRows[0]?.count ?? 0),
  };
}

/**
 * Витринная деталь по slug: ТОЛЬКО status='published'. null — нет/не опубликована
 * (роут отдаёт единый 404). С body + SEO/OG.
 */
export async function getPublishedNewsBySlug(
  slug: string,
): Promise<NewsArticle | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${newsCols()}
    FROM news
    WHERE slug = ${slug} AND status = 'published'
    LIMIT 1
  `;
  return rows[0] ? mapNews(rows[0]) : null;
}

// =============================================================================
// Запись (вызывается из actions.ts).
// =============================================================================

/** Поля вставки новости (нормализованы схемой/санитайзером в actions). */
export interface InsertNewsRow {
  slug: string;
  title: string;
  groupLabel: string | null;
  excerpt: string | null;
  body: string | null;
  coverImageKey: string | null;
  status: NewsStatus;
  publishedAt: Date | null;
  sortOrder: number;
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageKey: string | null;
  noindex: boolean;
  canonicalUrl: string | null;
  createdBy: string | null;
}

/** Вставляет новость, возвращает её id. Уникальность slug — на UNIQUE-индексе. */
export async function insertNews(input: InsertNewsRow): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO news (
      slug, title, group_label, excerpt, body, cover_image_key, status,
      published_at, sort_order, seo_title, seo_description, og_title,
      og_description, og_image_key, noindex, canonical_url, created_by, updated_by
    ) VALUES (
      ${input.slug}, ${input.title}, ${input.groupLabel}, ${input.excerpt},
      ${input.body}, ${input.coverImageKey}, ${input.status}, ${input.publishedAt},
      ${input.sortOrder}, ${input.seoTitle}, ${input.seoDescription}, ${input.ogTitle},
      ${input.ogDescription}, ${input.ogImageKey}, ${input.noindex}, ${input.canonicalUrl},
      ${input.createdBy}, ${input.createdBy}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

/** Поля обновления новости (partial). undefined-ключи не трогаются. */
export interface UpdateNewsRow {
  id: string;
  slug?: string;
  title?: string;
  groupLabel?: string | null;
  groupLabelProvided: boolean;
  excerpt?: string | null;
  excerptProvided: boolean;
  body?: string | null;
  bodyProvided: boolean;
  coverImageKey?: string | null;
  coverImageKeyProvided: boolean;
  status?: NewsStatus;
  publishedAt?: Date | null;
  publishedAtProvided: boolean;
  sortOrder?: number;
  seoTitle?: string | null;
  seoTitleProvided: boolean;
  seoDescription?: string | null;
  seoDescriptionProvided: boolean;
  ogTitle?: string | null;
  ogTitleProvided: boolean;
  ogDescription?: string | null;
  ogDescriptionProvided: boolean;
  ogImageKey?: string | null;
  ogImageKeyProvided: boolean;
  noindex?: boolean;
  canonicalUrl?: string | null;
  canonicalUrlProvided: boolean;
  translations?: TranslationsMap;
  translationsProvided: boolean;
  updatedBy: string | null;
}

/** UPDATE полей новости (partial: только переданные ключи через CASE WHEN provided). */
export async function updateNews(input: UpdateNewsRow): Promise<NewsArticle | null> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE news SET
      slug            = COALESCE(${input.slug ?? null}, slug),
      title           = COALESCE(${input.title ?? null}, title),
      group_label     = CASE WHEN ${input.groupLabelProvided}
                             THEN ${input.groupLabel ?? null} ELSE group_label END,
      excerpt         = CASE WHEN ${input.excerptProvided}
                             THEN ${input.excerpt ?? null} ELSE excerpt END,
      body            = CASE WHEN ${input.bodyProvided}
                             THEN ${input.body ?? null} ELSE body END,
      cover_image_key = CASE WHEN ${input.coverImageKeyProvided}
                             THEN ${input.coverImageKey ?? null} ELSE cover_image_key END,
      status          = COALESCE(${input.status ?? null}, status),
      published_at    = CASE WHEN ${input.publishedAtProvided}
                             THEN ${input.publishedAt ?? null} ELSE published_at END,
      sort_order      = COALESCE(${input.sortOrder ?? null}, sort_order),
      seo_title       = CASE WHEN ${input.seoTitleProvided}
                             THEN ${input.seoTitle ?? null} ELSE seo_title END,
      seo_description = CASE WHEN ${input.seoDescriptionProvided}
                             THEN ${input.seoDescription ?? null} ELSE seo_description END,
      og_title        = CASE WHEN ${input.ogTitleProvided}
                             THEN ${input.ogTitle ?? null} ELSE og_title END,
      og_description  = CASE WHEN ${input.ogDescriptionProvided}
                             THEN ${input.ogDescription ?? null} ELSE og_description END,
      og_image_key    = CASE WHEN ${input.ogImageKeyProvided}
                             THEN ${input.ogImageKey ?? null} ELSE og_image_key END,
      noindex         = COALESCE(${input.noindex ?? null}, noindex),
      canonical_url   = CASE WHEN ${input.canonicalUrlProvided}
                             THEN ${input.canonicalUrl ?? null} ELSE canonical_url END,
      translations    = CASE WHEN ${input.translationsProvided}
                             THEN ${sql.json((input.translations ?? {}) as Record<string, never>)}
                             ELSE translations END,
      updated_by      = ${input.updatedBy},
      updated_at      = now()
    WHERE id = ${input.id}
    RETURNING ${newsCols()}
  `;
  return rows[0] ? mapNews(rows[0]) : null;
}

/**
 * Смена статуса новости. При переходе в published — published_at=COALESCE(...,now())
 * (первая публикация проставляет метку; повторная сохраняет историческую).
 * Возвращает обновлённую запись или null (не найдена).
 */
export async function updateNewsStatus(
  id: string,
  status: NewsStatus,
  updatedBy: string | null,
): Promise<NewsArticle | null> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE news SET
      status       = ${status},
      published_at = CASE WHEN ${status} = 'published'
                          THEN COALESCE(published_at, now()) ELSE published_at END,
      updated_by   = ${updatedBy},
      updated_at   = now()
    WHERE id = ${id}
    RETURNING ${newsCols()}
  `;
  return rows[0] ? mapNews(rows[0]) : null;
}

/** Удаляет новость. Возвращает {id, slug} или null (не найдена). */
export async function deleteNews(
  id: string,
): Promise<{ id: string; slug: string } | null> {
  const rows = await sql<{ id: string; slug: string }[]>`
    DELETE FROM news WHERE id = ${id} RETURNING id, slug
  `;
  return rows[0] ?? null;
}
