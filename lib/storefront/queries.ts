/**
 * Тонкие read-only запросы Storefront API, которых нет в lib/catalog/repository
 * (slug→id товара, slug-и категорий товара). Только SELECT через `sql` (tagged
 * templates → параметризация). Бизнес-логику каталога НЕ дублируем — для самой
 * выборки товара/списков переиспользуем lib/catalog/repository.
 *
 * Эти функции зависят от БД, поэтому в тестах — под describe.skipIf(!DATABASE_URL).
 */

import { sql } from '@/lib/db/client';

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
