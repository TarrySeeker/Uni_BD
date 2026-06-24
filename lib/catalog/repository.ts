/**
 * Слой чтения каталога (docs/05 §4.1).
 *
 * Только SELECT через `sql` (tagged templates → параметризация, анти-SQLi).
 * Никаких мутаций здесь — они в actions.ts через defineAction.
 *
 * Маппинг row(snake_case)→domain(camelCase) вынесен в чистые функции map*,
 * экспортируемые для юнит-тестов (БД не нужна).
 */

import { sql } from '@/lib/db/client';
import { escapeLike } from '@/lib/db/like';
import { getEffectiveSettings } from '@/lib/config/settings';
import type {
  Attribute,
  AttributeValue,
  Brand,
  BrandRef,
  Category,
  CategoryTreeNode,
  InventoryItem,
  Product,
  ProductAttribute,
  ProductDetail,
  ProductListRow,
  ProductMedia,
  ProductStatus,
  ProductVariant,
} from './types';
import type { CategoryEdge } from './tree';
import { discountPercent, isOnSale, resolveIsNew } from './pricing';

// =============================================================================
// Чистые мапперы row→domain (тестируемы без БД).
// =============================================================================

function asDate(v: any): Date {
  return v instanceof Date ? v : new Date(v);
}
function asJson(v: any): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}
/** Целое или null (вес/габариты СДЭК, 0018): NULL/undefined → null, иначе Number. */
function asIntOrNull(v: any): number | null {
  return v === null || v === undefined ? null : Number(v);
}
/** Вес/габариты товара или варианта (0018) — общий для mapProduct/mapVariant. */
function mapDimsFields(row: any): {
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
} {
  return {
    weightG: asIntOrNull(row.weight_g),
    lengthCm: asIntOrNull(row.length_cm),
    widthCm: asIntOrNull(row.width_cm),
    heightCm: asIntOrNull(row.height_cm),
  };
}

/** Маппер расширенных SEO/OG-полей сущности (docs/11 §5.3); общий для 3 сущностей. */
function mapSeoFields(row: any): {
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageKey: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
} {
  return {
    ogTitle: row.og_title ?? null,
    ogDescription: row.og_description ?? null,
    ogImageKey: row.og_image_key ?? null,
    canonicalUrl: row.canonical_url ?? null,
    noindex: Boolean(row.noindex),
  };
}

export function mapCategory(row: any): Category {
  return {
    id: row.id,
    parentId: row.parent_id ?? null,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    sort: Number(row.sort),
    isActive: Boolean(row.is_active),
    seoTitle: row.seo_title ?? null,
    seoDescription: row.seo_description ?? null,
    ...mapSeoFields(row),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export function mapProduct(row: any): Product {
  return {
    id: row.id,
    sku: row.sku,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    status: row.status as ProductStatus,
    basePrice: String(row.base_price),
    compareAtPrice:
      row.compare_at_price === null || row.compare_at_price === undefined
        ? null
        : String(row.compare_at_price),
    isFeatured: Boolean(row.is_featured),
    isNew:
      row.is_new === null || row.is_new === undefined
        ? null
        : Boolean(row.is_new),
    brandId: row.brand_id ?? null,
    attributesCache: asJson(row.attributes_cache),
    seoTitle: row.seo_title ?? null,
    seoDescription: row.seo_description ?? null,
    ...mapSeoFields(row),
    ...mapDimsFields(row),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** Маппер развёрнутого бренда из LEFT JOIN (префикс b_); null, если бренда нет. */
export function mapBrandRef(row: any): BrandRef | null {
  if (!row || (row.b_id === null || row.b_id === undefined)) {
    return null;
  }
  return {
    id: row.b_id,
    slug: row.b_slug,
    name: row.b_name,
    // SQL JOIN отдаёт только b_logo_key; URL резолвится в DTO/админке.
    logoKey: row.b_logo_key ?? null,
  };
}

/** Полный маппер бренда (brands). */
export function mapBrand(row: any): Brand {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    // SQL отдаёт только logo_key; URL резолвится в DTO/админке (как og:image).
    logoKey: row.logo_key ?? null,
    isActive: Boolean(row.is_active),
    sort: Number(row.sort),
    seoTitle: row.seo_title ?? null,
    seoDescription: row.seo_description ?? null,
    ...mapSeoFields(row),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export function mapVariant(row: any): ProductVariant {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    name: row.name ?? '',
    priceOverride: row.price_override === null || row.price_override === undefined
      ? null
      : String(row.price_override),
    priceDelta: String(row.price_delta),
    compareAtPrice:
      row.compare_at_price === null || row.compare_at_price === undefined
        ? null
        : String(row.compare_at_price),
    isActive: Boolean(row.is_active),
    sort: Number(row.sort),
    attributesCache: asJson(row.attributes_cache),
    ...mapDimsFields(row),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export function mapAttribute(row: any): Attribute {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    unit: row.unit ?? null,
    isVariant: Boolean(row.is_variant),
    isFilterable: Boolean(row.is_filterable),
    isRequired: Boolean(row.is_required),
    sort: Number(row.sort),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export function mapAttributeValue(row: any): AttributeValue {
  return {
    id: row.id,
    attributeId: row.attribute_id,
    value: row.value,
    slug: row.slug ?? null,
    sort: Number(row.sort),
  };
}

export function mapProductAttribute(row: any): ProductAttribute {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id ?? null,
    attributeId: row.attribute_id,
    valueId: row.value_id ?? null,
    valueText: row.value_text ?? null,
  };
}

export function mapMedia(row: any): ProductMedia {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id ?? null,
    storageKey: row.storage_key,
    url: row.url ?? null,
    type: row.type,
    mime: row.mime,
    alt: row.alt ?? '',
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : Number(row.size_bytes),
    sort: Number(row.sort),
    isPrimary: Boolean(row.is_primary),
    createdAt: asDate(row.created_at),
  };
}

export function mapInventory(row: any): InventoryItem {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id ?? null,
    warehouseCode: row.warehouse_code,
    quantity: Number(row.quantity),
    reserved: Number(row.reserved),
    updatedAt: asDate(row.updated_at),
  };
}

// =============================================================================
// Категории.
// =============================================================================

/** Все рёбра дерева (id→parentId) — для чистой проверки циклов в moveCategory. */
export async function listCategoryEdges(): Promise<CategoryEdge[]> {
  const rows = await sql<{ id: string; parent_id: string | null }[]>`
    SELECT id, parent_id FROM categories
  `;
  return rows.map((r) => ({ id: r.id, parentId: r.parent_id ?? null }));
}

/** Плоский список всех категорий (отсортирован для сборки дерева). */
export async function listCategories(): Promise<Category[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, parent_id, slug, name, description, sort, is_active,
           seo_title, seo_description,
           og_title, og_description, og_image_key, canonical_url, noindex,
           created_at, updated_at
    FROM categories
    ORDER BY parent_id NULLS FIRST, sort, name
  `;
  return rows.map(mapCategory);
}

/** Собирает дерево категорий из плоского списка (чистая функция). */
export function buildCategoryTree(categories: Category[]): CategoryTreeNode[] {
  const nodes = new Map<string, CategoryTreeNode>();
  for (const c of categories) {
    nodes.set(c.id, { ...c, children: [] });
  }
  const roots: CategoryTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Дерево категорий (читает список и собирает иерархию). */
export async function getCategoryTree(): Promise<CategoryTreeNode[]> {
  return buildCategoryTree(await listCategories());
}

/** Сколько прямых детей у категории (для проверки RESTRICT-удаления). */
export async function countCategoryChildren(id: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM categories WHERE parent_id = ${id}
  `;
  return Number(rows[0]?.count ?? 0);
}

// =============================================================================
// Товары.
// =============================================================================

export type ProductSort =
  | 'created_desc'
  | 'name_asc'
  | 'price_asc'
  | 'price_desc';

export interface ProductListFilter {
  search?: string;
  status?: ProductStatus;
  categoryId?: string;
  /** Фасет по бренду (docs/06 §3.3). */
  brandId?: string;
  /** Подборка «Хиты» — только is_featured. */
  isFeatured?: boolean;
  /** Подборка «Новинки» — только с явным флагом is_new = true (override). */
  isNew?: boolean;
  /** Подборка «Со скидкой» — только товары с compare_at_price > base_price. */
  onSale?: boolean;
  page: number;
  pageSize: number;
  /**
   * Явный OFFSET (число пропускаемых строк). Если задан — имеет приоритет над
   * `page` и используется КАК ЕСТЬ (clamp >= 0, floor), без округления до границы
   * страницы. Нужен публичному API: свободный offset (не кратный pageSize) не
   * должен молча терять/дублировать товары между «страницами». Не задан → offset
   * вычисляется из page как (page-1)*pageSize (обратная совместимость).
   */
  offset?: number;
  sort?: ProductSort;
}

/**
 * Все id поддерева категории (сама категория + все потомки по parent_id).
 * Нужно для фильтра товаров по категории: товары назначаются на ЛИСТЬЯ дерева, а
 * пользователь часто выбирает РОДИТЕЛЬСКУЮ категорию (вкладка верхнего уровня) —
 * без поддерева такой выбор отдавал бы 0 товаров (баг каталога). Для категории
 * без потомков поддерево = [сама категория], т.е. поведение плоского каталога не
 * меняется. Несуществующая категория → пустой список → 0 товаров.
 */
export async function categorySubtreeIds(categoryId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM categories WHERE id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
    )
    SELECT id FROM subtree
  `;
  return rows.map((r) => r.id);
}

/**
 * Список товаров с фильтром/поиском(pg_trgm)/пагинацией (§4.1, §5.2).
 * Все условия параметризованы. Поиск — ILIKE по name/sku (GIN/pg_trgm индексы).
 * Фильтр по категории — РЕКУРСИВНЫЙ (включает товары подкатегорий).
 */
export async function listProducts(
  f: ProductListFilter,
): Promise<{ rows: ProductListRow[]; total: number }> {
  const page = Math.max(1, Math.floor(f.page));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize)));
  // Явный offset имеет приоритет и используется как есть (clamp >= 0). Иначе —
  // вычисляем из page (обратная совместимость). Так свободный offset (не кратный
  // pageSize) не округляется молча до границы страницы (пропуск/дубли товаров).
  const offset =
    f.offset !== undefined && Number.isFinite(f.offset)
      ? Math.max(0, Math.floor(f.offset))
      : (page - 1) * pageSize;

  const searchTerm = f.search?.trim() ? `%${escapeLike(f.search.trim())}%` : null;
  // Поддерево категории (сама + потомки) для рекурсивного фильтра. null = без фильтра.
  const categoryIds = f.categoryId ? await categorySubtreeIds(f.categoryId) : null;

  // «Новизна» для фасета «Новинки» (?new=1) и бейджа — ЕДИНЫЙ источник: эффективная
  // новизна = COALESCE(ручной override is_new, created_at >= порог newProductDays).
  // Фасет ОБЯЗАН совпадать с бейджем effective_is_new (БАГ #1, аудит волны 15): раньше
  // фасет смотрел только override is_new=true, без даты → товар, новый ПО ДАТЕ (с бейджем
  // «New»), не попадал в фильтр «Новинки». newThreshold считаем в JS тем же now/днями,
  // что и resolveIsNew (бейдж) — точное совпадение порога.
  const newDays = (await getEffectiveSettings()).catalog.newProductDays;
  const now = new Date();
  const newThreshold = new Date(now.getTime() - Math.max(0, newDays) * 24 * 60 * 60 * 1000);

  // Условия фильтрации — каждое значение параметризовано.
  // onSale/isFeatured/isNew — булевы фасеты витрины (docs/06 §3.1–§3.2):
  //  - onSale: вычисляемый предикат compare_at_price > base_price;
  //  - isFeatured: ручной флаг is_featured;
  //  - isNew: effective_is_new = COALESCE(override is_new, created_at >= порог) — как бейдж.
  const where = sql`
    WHERE (${searchTerm}::text IS NULL OR p.name ILIKE ${searchTerm} OR p.sku ILIKE ${searchTerm})
      AND (${f.status ?? null}::text IS NULL OR p.status = ${f.status ?? null})
      AND (${f.brandId ?? null}::uuid IS NULL OR p.brand_id = ${f.brandId ?? null})
      AND (${f.isFeatured ?? null}::boolean IS NULL OR p.is_featured = ${f.isFeatured ?? null})
      AND (${f.isNew ?? null}::boolean IS NULL
           OR ${f.isNew ?? null} = COALESCE(p.is_new, p.created_at >= ${newThreshold}))
      AND (${f.onSale ?? null}::boolean IS NULL
           OR (${f.onSale ?? null} = (p.compare_at_price IS NOT NULL AND p.compare_at_price > p.base_price)))
      AND (${categoryIds === null}::boolean OR EXISTS (
            SELECT 1 FROM product_categories pc
            WHERE pc.product_id = p.id AND pc.category_id = ANY(${categoryIds ?? []}::uuid[])
          ))
  `;

  const orderBy =
    f.sort === 'name_asc'
      ? sql`ORDER BY p.name ASC`
      : f.sort === 'price_asc'
        ? sql`ORDER BY p.base_price ASC`
        : f.sort === 'price_desc'
          ? sql`ORDER BY p.base_price DESC`
          : sql`ORDER BY p.created_at DESC`;

  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      p.id, p.sku, p.slug, p.name, p.status, p.base_price, p.created_at,
      p.compare_at_price, p.is_featured, p.is_new, p.brand_id,
      b.id AS b_id, b.slug AS b_slug, b.name AS b_name, b.logo_key AS b_logo_key,
      -- Остаток товара: строки вариантов всегда; строку уровня товара
      -- (variant_id IS NULL) учитываем ТОЛЬКО если у товара нет вариантов — иначе
      -- осиротевшая product-level строка (заданная до добавления вариантов)
      -- завышала бы наличие в каталоге (товар «в наличии», хотя все варианты пусты).
      -- m5: только основной склад ('main') — показ наличия совпадает с резервом/
      -- заказом (тоже main-only); мультисклад потребует отдельной логики.
      COALESCE((SELECT sum(i.quantity) FROM inventory i
        WHERE i.product_id = p.id
          AND i.warehouse_code = 'main'
          AND (i.variant_id IS NOT NULL
               OR NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id))), 0) AS total_stock,
      COALESCE((SELECT sum(GREATEST(i.quantity - i.reserved, 0)) FROM inventory i
        WHERE i.product_id = p.id
          AND i.warehouse_code = 'main'
          AND (i.variant_id IS NOT NULL
               OR NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id))), 0) AS available_stock,
      (SELECT m.url FROM product_media m
        WHERE m.product_id = p.id AND m.is_primary
        LIMIT 1) AS primary_media_url
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    ${where}
    ${orderBy}
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const totalRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM products p ${where}
  `;

  // «Новизна» товара — из эффективных настроек (env ⊕ БД), docs/11 §5.4.4.
  // newDays/now уже вычислены выше (используются и в фасете «Новинки»).
  const mapped: ProductListRow[] = rows.map((r: any) => {
    const createdAt =
      r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    const basePrice = String(r.base_price);
    const compareAtPrice =
      r.compare_at_price === null || r.compare_at_price === undefined
        ? null
        : String(r.compare_at_price);
    const isNew =
      r.is_new === null || r.is_new === undefined ? null : Boolean(r.is_new);
    return {
      id: r.id,
      sku: r.sku,
      slug: r.slug,
      name: r.name,
      status: r.status as ProductStatus,
      basePrice,
      compareAtPrice,
      discountPct: discountPercent(basePrice, compareAtPrice),
      onSale: isOnSale(basePrice, compareAtPrice),
      isFeatured: Boolean(r.is_featured),
      effectiveIsNew: resolveIsNew(isNew, createdAt, newDays, now),
      brand: mapBrandRef(r),
      totalStock: Number(r.total_stock ?? 0),
      availableStock: Number(r.available_stock ?? 0),
      primaryMediaUrl: r.primary_media_url ?? null,
      createdAt,
    };
  });

  return { rows: mapped, total: Number(totalRows[0]?.count ?? 0) };
}

/** Полная карточка товара со связями (§4.1). */
export async function getProductById(
  id: string,
): Promise<ProductDetail | null> {
  const prodRows = await sql<Record<string, unknown>[]>`
    SELECT p.id, p.sku, p.slug, p.name, p.description, p.status, p.base_price,
           p.compare_at_price, p.is_featured, p.is_new, p.brand_id,
           p.attributes_cache, p.seo_title, p.seo_description,
           p.og_title, p.og_description, p.og_image_key, p.canonical_url, p.noindex,
           p.weight_g, p.length_cm, p.width_cm, p.height_cm,
           p.created_at, p.updated_at,
           b.id AS b_id, b.slug AS b_slug, b.name AS b_name, b.logo_key AS b_logo_key
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.id = ${id} LIMIT 1
  `;
  if (!prodRows[0]) {
    return null;
  }
  const product = mapProduct(prodRows[0]);
  const brand = mapBrandRef(prodRows[0]);

  const [catRows, variantRows, attrRows, mediaRows, invRows] = await Promise.all([
    sql<{ category_id: string; is_primary: boolean }[]>`
      SELECT category_id, is_primary FROM product_categories WHERE product_id = ${id}
    `,
    sql<Record<string, unknown>[]>`
      SELECT id, product_id, sku, name, price_override, price_delta,
             compare_at_price, is_active, sort, attributes_cache,
             weight_g, length_cm, width_cm, height_cm, created_at, updated_at
      FROM product_variants WHERE product_id = ${id} ORDER BY sort, name
    `,
    sql<Record<string, unknown>[]>`
      SELECT id, product_id, variant_id, attribute_id, value_id, value_text
      FROM product_attributes WHERE product_id = ${id}
    `,
    sql<Record<string, unknown>[]>`
      SELECT id, product_id, variant_id, storage_key, url, type, mime, alt,
             width, height, size_bytes, sort, is_primary, created_at
      FROM product_media WHERE product_id = ${id} ORDER BY sort, created_at
    `,
    sql<Record<string, unknown>[]>`
      SELECT id, product_id, variant_id, warehouse_code, quantity, reserved, updated_at
      FROM inventory WHERE product_id = ${id}
    `,
  ]);

  return {
    ...product,
    categories: catRows.map((r) => ({
      categoryId: r.category_id,
      isPrimary: Boolean(r.is_primary),
    })),
    variants: variantRows.map(mapVariant),
    attributes: attrRows.map(mapProductAttribute),
    media: mediaRows.map(mapMedia),
    inventory: invRows.map(mapInventory),
    brand,
  };
}

// =============================================================================
// Характеристики / остатки (точечные чтения для actions/UI).
// =============================================================================

/** Все характеристики справочника. */
export async function listAttributes(): Promise<Attribute[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, code, name, type, unit, is_variant, is_filterable, is_required,
           sort, created_at, updated_at
    FROM attributes ORDER BY sort, name
  `;
  return rows.map(mapAttribute);
}

/** Значения словаря характеристики. */
export async function listAttributeValues(
  attributeId: string,
): Promise<AttributeValue[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, attribute_id, value, slug, sort
    FROM attribute_values WHERE attribute_id = ${attributeId} ORDER BY sort, value
  `;
  return rows.map(mapAttributeValue);
}

/**
 * Все значения словарей характеристик, сгруппированные по attribute_id —
 * для выпадающих списков выбора значения select-атрибутов в форме товара
 * (вместо ввода ID значения вручную).
 */
export async function listAttributeValuesByAttribute(): Promise<
  Record<string, AttributeValue[]>
> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, attribute_id, value, slug, sort
    FROM attribute_values ORDER BY attribute_id, sort, value
  `;
  const map: Record<string, AttributeValue[]> = {};
  for (const row of rows) {
    const v = mapAttributeValue(row);
    (map[v.attributeId] ??= []).push(v);
  }
  return map;
}

/** Остатки товара (все строки inventory). */
export async function listInventory(
  productId: string,
): Promise<InventoryItem[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, product_id, variant_id, warehouse_code, quantity, reserved, updated_at
    FROM inventory WHERE product_id = ${productId}
  `;
  return rows.map(mapInventory);
}

// =============================================================================
// Бренды (docs/06 §3.3, §4.3).
// =============================================================================

// Колонки бренда (инлайн в каждом запросе — не вычисляем sql-фрагмент на уровне
// модуля, иначе s`` дёрнет ленивый клиент при импорте без DATABASE_URL).

/** Список брендов; по умолчанию — все, опционально только активные. */
export async function listBrands(
  opts: { activeOnly?: boolean } = {},
): Promise<Brand[]> {
  const activeOnly = opts.activeOnly ?? false;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, name, description, logo_key, is_active, sort,
           seo_title, seo_description,
           og_title, og_description, og_image_key, canonical_url, noindex,
           created_at, updated_at
    FROM brands
    WHERE (${activeOnly} = false OR is_active = true)
    ORDER BY sort, name
  `;
  return rows.map(mapBrand);
}

/** Бренд по id или null. */
export async function getBrandById(id: string): Promise<Brand | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, name, description, logo_key, is_active, sort,
           seo_title, seo_description,
           og_title, og_description, og_image_key, canonical_url, noindex,
           created_at, updated_at
    FROM brands WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapBrand(rows[0]) : null;
}

/** Бренд по slug или null (для страницы бренда /brand/{slug}). */
export async function getBrandBySlug(slug: string): Promise<Brand | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, slug, name, description, logo_key, is_active, sort,
           seo_title, seo_description,
           og_title, og_description, og_image_key, canonical_url, noindex,
           created_at, updated_at
    FROM brands WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ? mapBrand(rows[0]) : null;
}
