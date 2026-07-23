/**
 * Слой чтения дизайнеров (§9, ADR §4.4). Зеркало брендовых listBrands/getBrand*.
 *
 * Только параметризованный `sql` (tagged templates → анти-SQLi). Мутации — в
 * actions.ts через defineAction. Маппер row(snake)→domain(camel) — чистая функция
 * mapDesigner, экспортируется для юнит-тестов (БД не нужна).
 *
 * translations/socials тянутся СЫРЫМИ (locale-агностично); резолв переводимых
 * полей — на границе (storefront DTO по ctx.locale; admin-форма по вкладке).
 */

import { sql } from '@/lib/db/client';
import { escapeLike } from '@/lib/db/like';
import type { TranslationsMap } from '@/lib/i18n';

import { applyDesignerSort, type DesignerSort } from './sort';
import type { Designer, DesignerSocials } from './types';

// -----------------------------------------------------------------------------
// Чистые мапперы row→domain.
// -----------------------------------------------------------------------------

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** Сырой jsonb-объект → Record. Не-объект/массив/NULL → {}. */
function asObject<T extends Record<string, unknown>>(v: unknown): T {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as T;
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as T)
        : ({} as T);
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

/** Полный маппер дизайнера (designers). */
export function mapDesigner(row: Record<string, unknown>): Designer {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    country: (row.country as string | null) ?? null,
    description: (row.description as string | null) ?? '',
    imageKey: (row.image_key as string | null) ?? null,
    pageImageKey: (row.page_image_key as string | null) ?? null,
    videoUrl: (row.video_url as string | null) ?? null,
    socials: asObject<DesignerSocials>(row.socials),
    workCount: row.work_count == null ? 0 : Number(row.work_count),
    isActive: Boolean(row.is_active),
    sort: Number(row.sort ?? 0),
    seoTitle: (row.seo_title as string | null) ?? null,
    seoDescription: (row.seo_description as string | null) ?? null,
    ogTitle: (row.og_title as string | null) ?? null,
    ogDescription: (row.og_description as string | null) ?? null,
    ogImageKey: (row.og_image_key as string | null) ?? null,
    canonicalUrl: (row.canonical_url as string | null) ?? null,
    noindex: Boolean(row.noindex),
    translations: asObject<TranslationsMap>(row.translations),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

// -----------------------------------------------------------------------------
// Чтения.
// -----------------------------------------------------------------------------

// Колонки дизайнера инлайнятся в каждый запрос: НЕ вычисляем sql``-фрагмент на
// уровне модуля, иначе ленивый клиент дёрнется при импорте без DATABASE_URL
// (тот же инвариант, что у listBrands — см. lib/catalog/repository).

/** Опции списка дизайнеров. Все поля необязательны — см. инвариант в listDesigners. */
export interface DesignerListOptions {
  activeOnly?: boolean;
  /** Подстрока для ILIKE по имени/стране/slug. Пустая строка = поиск выключен. */
  search?: string;
  /** Порядок; 'manual' (дефолт) = как отдала БД. */
  sort?: DesignerSort;
  /** Локаль коллатора для алфавита (настройка магазина). */
  locale?: string;
}

/**
 * Список дизайнеров; по умолчанию все, опционально только активные.
 *
 * ИНВАРИАНТ: вызов без аргументов ведёт себя ровно как раньше — searchTerm = null
 * гасит условие поиска, sort = 'manual' не переупорядочивает результат. На этом
 * держатся публичный Storefront API и селекты дизайнера в форме товара.
 *
 * Алфавит считается в приложении (Intl.Collator), а не в SQL: см. ./sort.ts.
 */
export async function listDesigners(
  opts: DesignerListOptions = {},
): Promise<Designer[]> {
  const activeOnly = opts.activeOnly ?? false;
  const search = opts.search?.trim();
  const searchTerm = search ? `%${escapeLike(search)}%` : null;

  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, name, country, description, image_key, page_image_key,
           video_url, socials, work_count, is_active, sort,
           seo_title, seo_description, og_title, og_description, og_image_key,
           canonical_url, noindex, translations, created_at, updated_at
    FROM designers
    WHERE (${activeOnly} = false OR is_active = true)
      AND (${searchTerm}::text IS NULL
           OR name ILIKE ${searchTerm}
           OR country ILIKE ${searchTerm}
           OR slug::text ILIKE ${searchTerm})
    ORDER BY sort, name
  `;
  return applyDesignerSort(rows.map(mapDesigner), opts.sort, opts.locale);
}

/** Дизайнер по id или null. */
export async function getDesignerById(id: string): Promise<Designer | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, name, country, description, image_key, page_image_key,
           video_url, socials, work_count, is_active, sort,
           seo_title, seo_description, og_title, og_description, og_image_key,
           canonical_url, noindex, translations, created_at, updated_at
    FROM designers WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapDesigner(rows[0]) : null;
}

/** Дизайнер по slug или null (для публичной страницы /designers/{slug}). */
export async function getDesignerBySlug(slug: string): Promise<Designer | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, name, country, description, image_key, page_image_key,
           video_url, socials, work_count, is_active, sort,
           seo_title, seo_description, og_title, og_description, og_image_key,
           canonical_url, noindex, translations, created_at, updated_at
    FROM designers WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ? mapDesigner(rows[0]) : null;
}

/** Активный дизайнер по slug (витрина скрывает неактивных). */
export async function getActiveDesignerBySlug(slug: string): Promise<Designer | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, name, country, description, image_key, page_image_key,
           video_url, socials, work_count, is_active, sort,
           seo_title, seo_description, og_title, og_description, og_image_key,
           canonical_url, noindex, translations, created_at, updated_at
    FROM designers WHERE slug = ${slug} AND is_active = true LIMIT 1
  `;
  return rows[0] ? mapDesigner(rows[0]) : null;
}
