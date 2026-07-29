/**
 * Тонкие read-only запросы Storefront API, которых нет в lib/catalog/repository
 * (slug→id товара, slug-и категорий товара). Только SELECT через `sql` (tagged
 * templates → параметризация). Бизнес-логику каталога НЕ дублируем — для самой
 * выборки товара/списков переиспользуем lib/catalog/repository.
 *
 * Эти функции зависят от БД, поэтому в тестах — под describe.skipIf(!DATABASE_URL).
 */

import { sql } from '@/lib/db/client';
import type { TranslationsMap } from '@/lib/i18n';
import {
  buildAttributeDictionary,
  type AttributeDictionary,
} from './attributes-i18n';

/**
 * Находит id товара по slug среди ОПУБЛИКОВАННЫХ (status='active') товаров.
 * Возвращает null, если товара нет или он не активен (черновики/архив витрине
 * не отдаём).
 */
export async function getActiveProductIdBySlug(
  slug: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM products
    WHERE slug = ${slug} AND status = 'active'
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Находит id активной категории по slug (для фильтра списка товаров витрины:
 * витрина знает slug категории из дерева /categories, но listProducts фильтрует
 * по categoryId). Возвращает null, если категории нет или она неактивна.
 */
export async function getActiveCategoryIdBySlug(
  slug: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM categories
    WHERE slug = ${slug} AND is_active = true
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Находит id активного дизайнера по slug (для фильтра товаров по дизайнеру:
 * страница /designers/{slug} знает slug, но listProducts фильтрует по designerId).
 * Возвращает null, если дизайнера нет или он неактивен (витрина скрывает неактивных,
 * зеркально getActiveCategoryIdBySlug).
 */
export async function getActiveDesignerIdBySlug(
  slug: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM designers
    WHERE slug = ${slug} AND is_active = true
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/** Slug-и категорий товара (для публичной карточки), только активные категории. */
export async function getProductCategorySlugs(
  productId: string,
): Promise<string[]> {
  const rows = await sql<{ slug: string }[]>`
    SELECT c.slug
    FROM product_categories pc
    JOIN categories c ON c.id = pc.category_id
    WHERE pc.product_id = ${productId} AND c.is_active = true
    ORDER BY pc.is_primary DESC, c.sort, c.name
  `;
  return rows.map((r) => r.slug);
}

/** Сырой jsonb → TranslationsMap; не-объект/NULL → {} (зеркало lib/catalog/repository). */
function asTranslations(v: unknown): TranslationsMap {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as TranslationsMap;
  }
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as TranslationsMap)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 🔴 Аудит minor №11 (остаток) — СЛОВАРЬ ПЕРЕВОДОВ характеристик и их значений
 * (attributes/attribute_values.translations, колонки из миграции 0034).
 *
 * Зачем отдельный запрос: `products.attributes_cache` — денормализованная проекция
 * EAV на языке по умолчанию, переводимой колонки у неё нет и быть не должно (кеш
 * производный). Поэтому DTO переводит кеш НА ГРАНИЦЕ по этому словарю; тем же
 * словарём переводятся имена цвето-свотчей (products.colors).
 *
 * Справочник характеристик магазина мал (десятки строк) и читается целиком одним
 * запросом — это дешевле, чем join на каждую карточку, и переиспользуемо для списка.
 *
 * НИКАКОГО хардкода кодов: словарь целиком из данных конкретного магазина.
 */
export async function getAttributeDictionary(): Promise<AttributeDictionary> {
  const [attrRows, valueRows] = await Promise.all([
    sql<{ code: string; name: string; translations: unknown }[]>`
      SELECT code, name, translations FROM attributes ORDER BY sort, name
    `,
    sql<{ attribute_code: string; value: string; translations: unknown }[]>`
      SELECT a.code AS attribute_code, av.value AS value, av.translations AS translations
      FROM attribute_values av
      JOIN attributes a ON a.id = av.attribute_id
      ORDER BY av.sort, av.value
    `,
  ]);
  return buildAttributeDictionary(
    attrRows.map((r) => ({
      code: String(r.code),
      name: r.name,
      translations: asTranslations(r.translations),
    })),
    valueRows.map((r) => ({
      attributeCode: String(r.attribute_code),
      value: r.value,
      translations: asTranslations(r.translations),
    })),
  );
}
