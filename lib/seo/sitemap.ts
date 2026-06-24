/**
 * Чистый билдер записей sitemap (docs/11 §5.3.4, пакет 5.S-1).
 *
 * buildSitemapEntries(modules, rows, ctx) фильтрует по включённым модулям и
 * исключает noindex/черновики. Домен — параметром (ctx.siteUrl), без чтения
 * env/БД внутри. core-always-on роут (app/sitemap.ts) сам читает модули/строки/
 * настройки и вызывает этот билдер.
 *
 * Инвариант (§5.3.7): карта НЕ ссылается на URL отключённых модулей —
 * catalog выкл ⇒ без товаров/категорий/брендов; cms выкл ⇒ без страниц.
 */

import type { ModuleName } from '@/lib/config/modules';

/** Строка сущности для карты (slug + флаг noindex). */
export interface SitemapRow {
  slug: string;
  noindex: boolean;
  /** Дата последнего изменения (опц.). */
  lastModified?: Date | string;
}

/** Наборы строк по типам сущностей (уже отфильтрованы по published/active на уровне запроса). */
export interface SitemapRows {
  products?: SitemapRow[];
  categories?: SitemapRow[];
  brands?: SitemapRow[];
  pages?: SitemapRow[];
}

/** Контекст билдера: домен из настроек. */
export interface SitemapCtx {
  siteUrl: string | null;
}

/** Запись sitemap (совместима с next MetadataRoute.Sitemap). */
export interface SitemapEntry {
  url: string;
  lastModified?: Date | string;
}

/** Префиксы путей по типам сущностей (соответствуют canonical-автогену). */
const PATH_PREFIX = {
  products: 'product',
  categories: 'category',
  brands: 'brand',
  pages: '', // CMS-страница: /<slug> (без префикса).
} as const;

/** Преобразует строки сущности в записи, фильтруя noindex и собирая URL. */
function rowsToEntries(
  rows: SitemapRow[] | undefined,
  prefix: string,
  siteUrl: string,
): SitemapEntry[] {
  if (!rows) return [];
  return rows
    .filter((r) => !r.noindex)
    .map((r) => ({
      url: prefix ? `${siteUrl}/${prefix}/${r.slug}` : `${siteUrl}/${r.slug}`,
      ...(r.lastModified ? { lastModified: r.lastModified } : {}),
    }));
}

/**
 * Строит записи sitemap. Всегда включает корень (site_url). Товары/категории/
 * бренды — только при включённом 'catalog'; страницы — при включённом 'cms'.
 * Без домена (siteUrl=null) возвращает пустой массив (нет хардкода).
 */
export function buildSitemapEntries(
  modules: ModuleName[],
  rows: SitemapRows,
  ctx: SitemapCtx,
): SitemapEntry[] {
  const siteUrl = ctx.siteUrl?.replace(/\/+$/, '') ?? null;
  if (!siteUrl) return [];

  const has = (m: ModuleName) => modules.includes(m);
  const entries: SitemapEntry[] = [{ url: siteUrl }];

  if (has('catalog')) {
    entries.push(...rowsToEntries(rows.products, PATH_PREFIX.products, siteUrl));
    entries.push(...rowsToEntries(rows.categories, PATH_PREFIX.categories, siteUrl));
    entries.push(...rowsToEntries(rows.brands, PATH_PREFIX.brands, siteUrl));
  }
  if (has('cms')) {
    entries.push(...rowsToEntries(rows.pages, PATH_PREFIX.pages, siteUrl));
  }

  return entries;
}
