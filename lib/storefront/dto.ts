/**
 * Публичные DTO Storefront API + чистые мапперы из доменных типов каталога
 * (docs/06 §6, ADR-008).
 *
 * ПРИНЦИП: витрине отдаём ТОЛЬКО публично-безопасные поля. НЕ раскрываем:
 *  - status товара (draft/archived вообще не должны попадать в выдачу — фильтр
 *    на уровне запроса), внутренние id связей, attributes_cache как сырой объект,
 *    storage_key медиа, точные остатки inventory.
 *  - вместо точного остатка отдаём `inStock: boolean` (доступное = quantity − reserved > 0).
 *    ОБОСНОВАНИЕ: точный остаток — коммерчески чувствительная информация (даёт
 *    конкуренту оценку оборота/закупок); витрине для кнопки «В корзину» достаточно
 *    булева «в наличии». При необходимости порога low-stock — отдельное решение.
 *
 * Цена/скидка отдаются ГОТОВЫМИ: discountPct и onSale вычисляются переиспользуемыми
 * функциями lib/catalog/pricing (без дублирования логики).
 *
 * Чистые функции — тестируемы без БД/Next.
 */

import { discountPercent, isOnSale, effectiveCompareAt } from '@/lib/catalog/pricing';
import { buildSeoMeta, type SeoCtx } from '@/lib/seo/meta';
import type {
  Brand,
  BrandRef,
  Category,
  CategoryTreeNode,
  InventoryItem,
  ProductDetail,
  ProductListRow,
  ProductMedia,
  ProductVariant,
} from '@/lib/catalog/types';
import { MAIN_WAREHOUSE } from '@/lib/catalog/types';

// ---------------------------------------------------------------------------
// Типы публичных DTO.
// ---------------------------------------------------------------------------

/**
 * Резолвер «ключ объекта хранилища → публичный URL» (инъекция storage.url).
 * Единый источник истины для всех Storefront-мапперов (cms-dto переэкспортирует).
 * Сырой S3-ключ наружу НЕ отдаём — URL собирается на границе мапперов.
 */
export type PublicUrlResolver = (key: string) => string;

/**
 * Публичная SEO-мета сущности (docs/11 §5.3.4). Наружу — ТОЛЬКО `ogImageUrl`
 * (НЕ ключ S3): URL собирается storage.publicUrl на границе мапперов.
 */
export interface SeoMetaDto {
  title: string;
  description: string | null;
  canonical: string | null;
  ogTitle: string;
  ogDescription: string | null;
  ogImageUrl: string | null;
  noindex: boolean;
}

export interface BrandDto {
  slug: string;
  name: string;
  logoUrl: string | null;
}

export interface FullBrandDto extends BrandDto {
  description: string;
  seoTitle: string | null;
  seoDescription: string | null;
  meta: SeoMetaDto;
}

export interface CategoryDto {
  slug: string;
  name: string;
  description: string;
  children: CategoryDto[];
  /** SEO-мета категории (опц.: дерево-маппер её не собирает). */
  meta?: SeoMetaDto;
}

export interface MediaDto {
  url: string | null;
  type: string;
  alt: string;
  isPrimary: boolean;
}

export interface VariantDto {
  id: string;
  sku: string;
  /** Человекочитаемое название варианта (напр. «M» или «Красный / M»); '' если не задано. */
  name: string;
  /** Эффективная цена варианта как строка NUMERIC (точность не теряется). */
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  /** Публичные атрибуты варианта (denormalized cache — без внутренних id). */
  attributes: Record<string, unknown>;
  /** В наличии (inventory > 0). */
  inStock: boolean;
  /**
   * Доступное к заказу количество (quantity − reserved, ≥0). Нужно витрине, чтобы
   * ОГРАНИЧИТЬ счётчик количества в корзине остатком (раньше можно было добавить
   * сколько угодно при остатке 1). Это та же величина, что драйвит `inStock`.
   */
  availableQty: number;
}

export interface ProductListItemDto {
  slug: string;
  name: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  isNew: boolean;
  isFeatured: boolean;
  brand: BrandDto | null;
  imageUrl: string | null;
  inStock: boolean;
  /** Доступное к заказу количество (≥0) — для ограничения корзины (см. VariantDto.availableQty). */
  availableQty: number;
}

export interface ProductDetailDto {
  /**
   * Публичный id товара. Нужен витрине, чтобы заказать товар БЕЗ вариантов
   * (cart/quote/orders принимают productId, когда variantId отсутствует —
   * ADR-010). Сопоставимо по чувствительности с уже публичными id вариантов.
   */
  id: string;
  slug: string;
  sku: string;
  name: string;
  description: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  isNew: boolean;
  isFeatured: boolean;
  brand: BrandDto | null;
  categories: string[];
  attributes: Record<string, unknown>;
  variants: VariantDto[];
  media: MediaDto[];
  inStock: boolean;
  /**
   * Доступное к заказу количество на уровне ТОВАРА (для товара без вариантов —
   * витрина заказывает по productId). Для товара с вариантами лимит берётся из
   * VariantDto.availableQty выбранного варианта.
   */
  availableQty: number;
  meta: SeoMetaDto;
}

// ---------------------------------------------------------------------------
// Мапперы.
// ---------------------------------------------------------------------------

/**
 * Бренд-ref → публичный BrandDto (только name/slug/logo).
 *
 * `publicUrl` (storage.url) инъецируется роутом и резолвит logoKey → публичный
 * URL — сырой S3-ключ наружу НЕ отдаём (зеркально toMediaDto/og:image). Без
 * резолвера logoUrl=null (обратная совместимость, не падаем) — раньше logoUrl
 * был всегда null из-за фантомного поля domain.logoUrl (регресс волны 4).
 */
export function toBrandDto(
  brand: BrandRef | null,
  publicUrl?: PublicUrlResolver,
): BrandDto | null {
  if (!brand) {
    return null;
  }
  return {
    slug: brand.slug,
    name: brand.name,
    logoUrl: brand.logoKey && publicUrl ? publicUrl(brand.logoKey) : null,
  };
}

/** Опции мапперов, несущих SEO-мету (seoCtx инъецируется параметром). */
export interface SeoMapOpts {
  seoCtx: SeoCtx;
  /**
   * Резолвер ключ → URL для логотипа бренда. Опционален: по умолчанию берётся
   * `seoCtx.publicUrl` (тот же storage.url). Явно нужен, когда seoCtx собран под
   * иной pathPrefix, но резолвер логотипа должен совпадать.
   */
  publicUrl?: PublicUrlResolver;
}

/** Строит SeoMetaDto сущности через чистый билдер (наружу — ogImageUrl, не ключ). */
function entityMeta(
  entity: {
    slug: string;
    name: string;
    seoTitle: string | null;
    seoDescription: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImageKey: string | null;
    canonicalUrl: string | null;
    noindex: boolean;
  },
  ctx: SeoCtx,
): SeoMetaDto {
  return buildSeoMeta(entity, ctx);
}

/**
 * Полный бренд → публичный FullBrandDto (для /brands). Внутренние поля скрыты.
 *
 * logoUrl резолвится из logoKey через резолвер: по умолчанию — `opts.seoCtx.publicUrl`
 * (тот же storage.url, что собирает og:image), либо явный `opts.publicUrl`. Без
 * ключа → null. Это закрывает регресс волны 4 (logoUrl был всегда null).
 */
export function toFullBrandDto(brand: Brand, opts: SeoMapOpts): FullBrandDto {
  const publicUrl = opts.publicUrl ?? opts.seoCtx.publicUrl;
  return {
    slug: brand.slug,
    name: brand.name,
    logoUrl: brand.logoKey ? publicUrl(brand.logoKey) : null,
    description: brand.description,
    seoTitle: brand.seoTitle,
    seoDescription: brand.seoDescription,
    meta: entityMeta(brand, opts.seoCtx),
  };
}

/**
 * Узел дерева категорий (или плоская категория) → CategoryDto, рекурсивно.
 * Если передан seoCtx — добавляет `meta` (для страницы категории); без него
 * (дерево-маппер) meta опускается.
 */
export function toCategoryDto(
  node: CategoryTreeNode | Category,
  opts?: { seoCtx?: SeoCtx },
): CategoryDto {
  const children = 'children' in node && Array.isArray(node.children) ? node.children : [];
  return {
    slug: node.slug,
    name: node.name,
    description: node.description,
    children: children.map((c) => toCategoryDto(c)),
    ...(opts?.seoCtx ? { meta: entityMeta(node, opts.seoCtx) } : {}),
  };
}

/** Дерево категорий → DTO, скрывая неактивные ветви. */
export function toCategoryTreeDto(tree: CategoryTreeNode[]): CategoryDto[] {
  return tree
    .filter((n) => n.isActive)
    .map((n) => ({
      slug: n.slug,
      name: n.name,
      description: n.description,
      children: toCategoryTreeDto(n.children),
    }));
}

/**
 * Строка списка товаров → публичный DTO (price/скидка готовы).
 *
 * `publicUrl` (storage.url) инъецируется роутом — резолвит логотип бренда из
 * logoKey. Опционален (обратная совместимость): без него brand.logoUrl=null.
 */
export function toProductListItemDto(
  row: ProductListRow,
  publicUrl?: PublicUrlResolver,
): ProductListItemDto {
  return {
    slug: row.slug,
    name: row.name,
    price: row.basePrice,
    compareAtPrice: row.compareAtPrice,
    discountPct: row.discountPct,
    onSale: row.onSale,
    isNew: row.effectiveIsNew,
    isFeatured: row.isFeatured,
    brand: toBrandDto(row.brand, publicUrl),
    imageUrl: row.primaryMediaUrl,
    // «В наличии» = есть доступное (quantity − reserved > 0), а не физический
    // остаток: зарезервированное под незавершённые заказы не показываем (оверселл).
    // Семантика совпадает с computeInStock карточки/детали.
    inStock: row.availableStock > 0,
    availableQty: Math.max(0, row.availableStock),
  };
}

/** Медиа → публичный DTO (без storage_key/размеров/байт). */
export function toMediaDto(media: ProductMedia): MediaDto {
  return {
    url: media.url,
    type: media.type,
    alt: media.alt,
    isPrimary: media.isPrimary,
  };
}

/**
 * Считает «в наличии» по строкам inventory (опц. фильтр по варианту).
 *
 * Доступно = quantity − reserved: зарезервированное под незавершённые заказы НЕ
 * показывается витрине как «в наличии» (иначе оверселл). Разность > 0 корректно
 * отсекает и полный резерв (=0), и рассинхрон reserved > quantity (< 0).
 *
 * `warehouseCode` (m5): если задан — учитываются только строки этого склада. Витрина
 * передаёт MAIN_WAREHOUSE, чтобы показ совпадал с резервом/заказом (тоже main-only);
 * без него (undefined) считаются все склады (обратная совместимость).
 */
export function computeInStock(
  inventory: InventoryItem[],
  variantId?: string | null,
  warehouseCode?: string,
): boolean {
  return inventory.some(
    (i) =>
      i.quantity - i.reserved > 0 &&
      (variantId === undefined || (i.variantId ?? null) === (variantId ?? null)) &&
      // m5: регистронезависимо — колонка warehouse_code citext (резерв/заказ
      // сравнивают регистронезависимо в БД); строгий === расходился бы с ними.
      (warehouseCode === undefined ||
        i.warehouseCode.toLowerCase() === warehouseCode.toLowerCase()),
  );
}

/**
 * Доступное к заказу количество по строкам inventory (опц. фильтр по варианту).
 *
 * Сумма max(quantity − reserved, 0): зарезервированное под незавершённые заказы
 * не доступно (иначе оверселл); отрицательный рассинхрон reserved>quantity
 * отсекается в 0. Та же база, что и computeInStock (булева версия), но число —
 * витрина ограничивает им счётчик количества в корзине.
 *
 * `warehouseCode` (m5): если задан — суммируются только строки этого склада
 * (витрина передаёт MAIN_WAREHOUSE — совпадает с резервом/заказом main-only).
 */
export function computeAvailableQty(
  inventory: InventoryItem[],
  variantId?: string | null,
  warehouseCode?: string,
): number {
  return inventory.reduce(
    (sum, i) =>
      (variantId === undefined || (i.variantId ?? null) === (variantId ?? null)) &&
      // m5: регистронезависимо (citext) — см. computeInStock.
      (warehouseCode === undefined ||
        i.warehouseCode.toLowerCase() === warehouseCode.toLowerCase())
        ? sum + Math.max(0, i.quantity - i.reserved)
        : sum,
    0,
  );
}

/**
 * Эффективная цена варианта как строка: priceOverride, иначе basePrice+priceDelta.
 * Деньги — строки NUMERIC; складываем через число, форматируем 2 знака.
 */
export function effectiveVariantPrice(
  variant: ProductVariant,
  basePrice: string,
): string {
  if (variant.priceOverride !== null && variant.priceOverride !== undefined) {
    return variant.priceOverride;
  }
  const base = Number(basePrice);
  const delta = Number(variant.priceDelta ?? '0');
  if (!Number.isFinite(base) || !Number.isFinite(delta)) {
    return basePrice;
  }
  return (base + delta).toFixed(2);
}

/** Вариант → публичный DTO (цена/скидка/inStock). */
export function toVariantDto(
  variant: ProductVariant,
  product: ProductDetail,
): VariantDto {
  const price = effectiveVariantPrice(variant, product.basePrice);
  const compareAt = effectiveCompareAt(
    variant.compareAtPrice,
    product.compareAtPrice,
  );
  const compareAtStr = compareAt !== null ? compareAt.toFixed(2) : null;
  return {
    id: variant.id,
    sku: variant.sku,
    name: variant.name ?? '',
    price,
    compareAtPrice: compareAtStr,
    discountPct: discountPercent(price, compareAtStr),
    onSale: isOnSale(price, compareAtStr),
    attributes: variant.attributesCache ?? {},
    inStock: computeInStock(product.inventory, variant.id, MAIN_WAREHOUSE),
    availableQty: computeAvailableQty(product.inventory, variant.id, MAIN_WAREHOUSE),
  };
}

/**
 * Полная карточка товара → публичный DTO.
 *
 * effectiveIsNew — вычисленная «новизна» (троичная логика). Поскольку
 * ProductDetail хранит сырой `isNew`, передаём готовое значение параметром
 * (роут вычисляет через resolveIsNew с настройкой магазина).
 */
export function toProductDetailDto(
  product: ProductDetail,
  opts: { effectiveIsNew: boolean; categorySlugs: string[]; seoCtx: SeoCtx },
): ProductDetailDto {
  // При наличии активных вариантов наличие/доступное количество ТОВАРА считаем
  // ТОЛЬКО по вариантам: осиротевший product-level остаток (variant_id IS NULL)
  // не заказуем (заказ идёт по variantId) и завышал бы наличие — тот же инвариант,
  // что в listProducts (волна 14). Без вариантов остаток на уровне товара —
  // единственный и заказуется по productId.
  const hasActiveVariants = product.variants.some((v) => v.isActive);
  const orderableInventory = hasActiveVariants
    ? product.inventory.filter((i) => (i.variantId ?? null) !== null)
    : product.inventory;
  return {
    id: product.id,
    slug: product.slug,
    sku: product.sku,
    name: product.name,
    description: product.description,
    price: product.basePrice,
    compareAtPrice: product.compareAtPrice,
    discountPct: discountPercent(product.basePrice, product.compareAtPrice),
    onSale: isOnSale(product.basePrice, product.compareAtPrice),
    isNew: opts.effectiveIsNew,
    isFeatured: product.isFeatured,
    // Логотип бренда резолвится тем же storage.url, что и og:image (seoCtx.publicUrl).
    brand: toBrandDto(product.brand, opts.seoCtx.publicUrl),
    categories: opts.categorySlugs,
    attributes: product.attributesCache ?? {},
    variants: product.variants
      .filter((v) => v.isActive)
      .map((v) => toVariantDto(v, product)),
    media: product.media.map(toMediaDto),
    inStock: computeInStock(orderableInventory, undefined, MAIN_WAREHOUSE),
    // Уровень товара (для товара без вариантов — заказ по productId).
    availableQty: computeAvailableQty(orderableInventory, undefined, MAIN_WAREHOUSE),
    meta: entityMeta(product, opts.seoCtx),
  };
}
