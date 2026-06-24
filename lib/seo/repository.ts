/**
 * Слой чтения строк для sitemap (docs/11 §5.3.4, пакет 5.S-1).
 *
 * ТОЛЬКО SELECT через `sql` (параметризовано). Возвращает slug + noindex +
 * lastModified по каждой публично-видимой сущности. Фильтрация по статусу/
 * активности — на уровне запроса (active товары, активные категории/бренды,
 * published CMS-страницы); фильтр по noindex и модулям — в чистом билдере
 * buildSitemapEntries. Защитно толерантен к отсутствию таблиц (cms_pages может
 * быть ещё не накатана) — to_regclass-гард.
 */

import { sql } from '@/lib/db/client';
import type { SitemapRows, SitemapRow } from '@/lib/seo/sitemap';

/** Безопасно нормализует строку результата в SitemapRow. */
function toRow(r: { slug: string; noindex: boolean; updated_at?: Date | string }): SitemapRow {
  return {
    slug: r.slug,
    noindex: Boolean(r.noindex),
    ...(r.updated_at ? { lastModified: r.updated_at } : {}),
  };
}

/** Активные товары (status='active') — slug/noindex/updated_at. */
export async function getSitemapProducts(): Promise<SitemapRow[]> {
  const rows = await sql<{ slug: string; noindex: boolean; updated_at: Date }[]>`
    SELECT slug, noindex, updated_at FROM products WHERE status = 'active'
  `;
  return rows.map(toRow);
}

/** Активные категории (is_active=true). */
export async function getSitemapCategories(): Promise<SitemapRow[]> {
  const rows = await sql<{ slug: string; noindex: boolean; updated_at: Date }[]>`
    SELECT slug, noindex, updated_at FROM categories WHERE is_active = true
  `;
  return rows.map(toRow);
}

/** Активные бренды (is_active=true). */
export async function getSitemapBrands(): Promise<SitemapRow[]> {
  const rows = await sql<{ slug: string; noindex: boolean; updated_at: Date }[]>`
    SELECT slug, noindex, updated_at FROM brands WHERE is_active = true
  `;
  return rows.map(toRow);
}

/**
 * Опубликованные CMS-страницы (status='published'). Толерантна к отсутствию
 * таблицы cms_pages (модуль 5.1 может быть ещё не накатан) — to_regclass-гард.
 */
export async function getSitemapPages(): Promise<SitemapRow[]> {
  try {
    const rows = await sql<{ slug: string; noindex: boolean; updated_at: Date }[]>`
      SELECT slug, noindex, updated_at FROM cms_pages
      WHERE status = 'published'
        AND to_regclass('public.cms_pages') IS NOT NULL
    `;
    return rows.map(toRow);
  } catch {
    return [];
  }
}

/**
 * Собирает все наборы строк для sitemap одним вызовом. Фильтр по модулям/noindex
 * выполняет чистый билдер buildSitemapEntries поверх результата.
 */
export async function getSitemapRows(): Promise<SitemapRows> {
  const [products, categories, brands, pages] = await Promise.all([
    getSitemapProducts(),
    getSitemapCategories(),
    getSitemapBrands(),
    getSitemapPages(),
  ]);
  return { products, categories, brands, pages };
}
