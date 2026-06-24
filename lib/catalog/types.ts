/**
 * Доменные типы каталога (docs/05 §2 «Схема БД»).
 *
 * Это типы прикладного уровня (camelCase), отображающие строки таблиц каталога.
 * Маппинг row(snake_case)→domain(camelCase) — в repository.ts (функции map*).
 * Деньги моделируются строкой (NUMERIC(14,2) приходит из postgres.js строкой,
 * чтобы не терять точность); парсинг в число — на уровне представления.
 */

// -----------------------------------------------------------------------------
// Перечисления / литеральные типы (соответствуют CHECK-ограничениям в БД).
// -----------------------------------------------------------------------------

/** Жизненный цикл товара (products.status). */
export type ProductStatus = 'draft' | 'active' | 'archived';
export const PRODUCT_STATUSES: readonly ProductStatus[] = [
  'draft',
  'active',
  'archived',
] as const;

/** Тип значения характеристики (attributes.type). */
export type AttributeType = 'select' | 'text' | 'number' | 'boolean';
export const ATTRIBUTE_TYPES: readonly AttributeType[] = [
  'select',
  'text',
  'number',
  'boolean',
] as const;

/** Тип медиа (product_media.type). */
export type MediaType = 'image' | 'video' | 'document';
export const MEDIA_TYPES: readonly MediaType[] = [
  'image',
  'video',
  'document',
] as const;

// -----------------------------------------------------------------------------
// Сущности.
// -----------------------------------------------------------------------------

/** Категория дерева (categories). */
export interface Category {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string;
  sort: number;
  isActive: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  /** Ключ объекта OG-изображения в хранилище (URL собирает storage). */
  ogImageKey: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Узел дерева категорий с детьми (для рендера дерева). */
export interface CategoryTreeNode extends Category {
  children: CategoryTreeNode[];
}

/** Товар (products). */
export interface Product {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  status: ProductStatus;
  /** NUMERIC(14,2) как строка — точность не теряется. */
  basePrice: string;
  /** Цена «было» для сравнения (docs/06 §3.1); null → нет акции. Скидка вычисляется. */
  compareAtPrice: string | null;
  /** Ручной флаг «Хит/Рекомендуемый» (docs/06 §3.2). */
  isFeatured: boolean;
  /** Троичная «новизна»: null → вычисляемо по дате; true/false → override (docs/06 §3.2). */
  isNew: boolean | null;
  /** Бренд товара (docs/06 §3.3); null → без бренда. */
  brandId: string | null;
  /** Денормализованная проекция характеристик (ADR-007). */
  attributesCache: Record<string, unknown>;
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  /** Ключ объекта OG-изображения в хранилище (URL собирает storage). */
  ogImageKey: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  /** Вес товара в граммах для расчёта/создания доставки СДЭК (0018); null → дефолт магазина. */
  weightG: number | null;
  /** Габариты товара в см (0018); null → дефолт магазина (CDEK_DEFAULT_*). */
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Краткая ссылка на бренд для развёрнутой проекции товара (карточка/список). */
export interface BrandRef {
  id: string;
  slug: string;
  name: string;
  /**
   * Ключ объекта логотипа в хранилище (как product_media.storage_key). URL
   * собирается на границе представления (DTO/админка) через storage.url(key) —
   * домен не хранится в домене (зеркально og:image, см. lib/seo/meta).
   */
  logoKey: string | null;
}

/** Бренд / производитель (brands, docs/06 §3.3). */
export interface Brand {
  id: string;
  slug: string;
  name: string;
  description: string;
  /**
   * Ключ объекта логотипа в хранилище (как product_media.storage_key). URL
   * собирается на границе представления (DTO/админка) через storage.url(key) —
   * URL в доменной модели НЕ храним (зеркально og:image, см. lib/seo/meta).
   */
  logoKey: string | null;
  isActive: boolean;
  sort: number;
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  /** Ключ объекта OG-изображения в хранилище (URL собирает storage). */
  ogImageKey: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Вариант товара (product_variants). */
export interface ProductVariant {
  id: string;
  productId: string;
  sku: string;
  name: string;
  /** Абсолютная цена варианта; null → берётся basePrice (+delta). */
  priceOverride: string | null;
  /** Надбавка к basePrice. */
  priceDelta: string;
  /** Цена «было» на уровне варианта; null → наследуется от товара (docs/06 §3.1). */
  compareAtPrice: string | null;
  isActive: boolean;
  sort: number;
  attributesCache: Record<string, unknown>;
  /** Вес варианта в граммах (0018); null → берётся от товара → дефолт магазина. */
  weightG: number | null;
  /** Габариты варианта в см (0018); null → берётся от товара → дефолт магазина. */
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Метаданные характеристики-справочника (attributes). */
export interface Attribute {
  id: string;
  code: string;
  name: string;
  type: AttributeType;
  unit: string | null;
  isVariant: boolean;
  isFilterable: boolean;
  isRequired: boolean;
  sort: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Значение из словаря характеристики (attribute_values). */
export interface AttributeValue {
  id: string;
  attributeId: string;
  value: string;
  slug: string | null;
  sort: number;
}

/** Привязка характеристики к товару/варианту (product_attributes). */
export interface ProductAttribute {
  id: string;
  productId: string;
  variantId: string | null;
  attributeId: string;
  valueId: string | null;
  valueText: string | null;
}

/** Медиафайл товара/варианта (product_media). */
export interface ProductMedia {
  id: string;
  productId: string;
  variantId: string | null;
  storageKey: string;
  url: string | null;
  type: MediaType;
  mime: string;
  alt: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  sort: number;
  isPrimary: boolean;
  createdAt: Date;
}

/**
 * Код основного склада. Единый источник правды (m5): и резерв/заказ
 * (lib/orders/repository), и витринный показ наличия (lib/storefront/dto) считают
 * по нему. Платформа однонкладная по умолчанию — резервирование/списание идут
 * только по 'main'; показ наличия скоупится тем же складом, чтобы «доступно к
 * заказу» на витрине совпадало с тем, что реально можно зарезервировать.
 */
export const MAIN_WAREHOUSE = 'main';

/** Остаток (inventory). */
export interface InventoryItem {
  id: string;
  productId: string;
  variantId: string | null;
  warehouseCode: string;
  quantity: number;
  reserved: number;
  updatedAt: Date;
}

/**
 * Товар с присоединёнными связями — результат getProductById (§4.1).
 */
export interface ProductDetail extends Product {
  categories: Array<{ categoryId: string; isPrimary: boolean }>;
  variants: ProductVariant[];
  attributes: ProductAttribute[];
  media: ProductMedia[];
  inventory: InventoryItem[];
  /** Развёрнутый бренд (LEFT JOIN brands), если у товара есть brand_id. */
  brand: BrandRef | null;
}

/** Строка списка товаров (компактная проекция для таблицы админки). */
export interface ProductListRow {
  id: string;
  sku: string;
  slug: string;
  name: string;
  status: ProductStatus;
  basePrice: string;
  /** Цена «было» (docs/06 §3.1); null → нет акции. */
  compareAtPrice: string | null;
  /** Процент скидки (вычислен из base_price/compare_at_price); null → не на распродаже. */
  discountPct: number | null;
  /** Предикат «со скидкой» (compare_at_price > base_price). */
  onSale: boolean;
  /** Ручной флаг «Хит/Рекомендуемый». */
  isFeatured: boolean;
  /** Вычисленная «новизна» (учитывает override is_new и порог SHOP_NEW_PRODUCT_DAYS). */
  effectiveIsNew: boolean;
  /** Бренд товара (компактно), если есть. */
  brand: BrandRef | null;
  /** Суммарный физический остаток по всем строкам inventory (для админки). */
  totalStock: number;
  /**
   * Доступное к продаже по всем строкам inventory: sum(max(quantity − reserved, 0)).
   * Драйвер витринного inStock — зарезервированное под незавершённые заказы не
   * показывается «в наличии» (иначе оверселл). Семантика совпадает с computeInStock.
   */
  availableStock: number;
  /** URL главного изображения (is_primary), если есть. */
  primaryMediaUrl: string | null;
  createdAt: Date;
}
