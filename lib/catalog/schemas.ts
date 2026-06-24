/**
 * Zod-схемы входа для Server Actions каталога (docs/05 §4).
 *
 * Экспортируются для переиспользования в UI (формы админки): один источник
 * правды о форме входных данных. Все мутации каталога валидируются этими
 * схемами внутри defineAction (§4.7).
 *
 * Правила контракта (docs/05 §2):
 *  - slug — строгий ЧПУ ([a-z0-9-], без двойных/краевых дефисов);
 *  - деньги — строка NUMERIC ≥ 0 (точность не теряем, валидируем формат);
 *  - id — uuid; status/type — литералы из CHECK-ограничений БД.
 */

import { z } from 'zod';

import {
  ATTRIBUTE_TYPES,
  MEDIA_TYPES,
  PRODUCT_STATUSES,
} from './types';
import {
  ogTitleSchema,
  ogDescriptionSchema,
  ogImageKeySchema,
  canonicalUrlSchema,
  noindexSchema,
} from '@/lib/seo/schemas';

// -----------------------------------------------------------------------------
// Переиспользуемые примитивы.
// -----------------------------------------------------------------------------

/** UUID-идентификатор. */
export const uuidSchema = z.string().uuid();

/**
 * Строгий slug: только [a-z0-9] с одиночными дефисами между сегментами.
 * Совпадает с выходом slugify / isValidSlug.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'slug: только латиница в нижнем регистре, цифры и дефисы (без двойных/краевых дефисов)',
  );

/** Артикул (sku): непустой, регистронезависим в БД (citext); до 100 символов. */
export const skuSchema = z.string().trim().min(1).max(100);

/**
 * Денежная сумма NUMERIC(14,2) ≥ 0 как строка.
 * Принимает целое/дробное (до 2 знаков), без минуса. Длина целой части ≤ 12.
 */
export const moneySchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(?:\.\d{1,2})?$/,
    'цена: неотрицательное число с не более чем 2 знаками после точки',
  );

/** Код характеристики (attributes.code): стабильный идентификатор. */
export const attributeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9_]+$/,
    'код атрибута: латиница в нижнем регистре, цифры и подчёркивание',
  );

const seoTitle = z.string().max(255).optional();
const seoDescription = z.string().max(1000).optional();

/**
 * Вес/габариты для расчёта СДЭК (0018, docs/08 §3.2): целое ≥ 0, nullable.
 * null → берётся вышестоящий уровень (вариант→товар) или дефолт магазина
 * (CDEK_DEFAULT_*). Вес — в граммах, габариты — в сантиметрах.
 */
const dimensionSchema = z.number().int().min(0).nullish();

/** Поля веса/габаритов товара/варианта (0018) — подмешиваются в create/update-схемы. */
export const dimensionFields = {
  weightG: dimensionSchema,
  lengthCm: dimensionSchema,
  widthCm: dimensionSchema,
  heightCm: dimensionSchema,
} as const;

/**
 * Расширенные SEO/OG-поля сущностей каталога (docs/11 §5.3). Подмешиваются в
 * Update-схемы товара/категории/бренда. canonicalUrl валидируется на безопасность
 * (абсолютный https / path с '/'); мусор (javascript:, относительный без '/') →
 * validation. ogImageKey — КЛЮЧ S3 (URL собирает storage, наружу не утекает).
 */
export const seoEntityFields = {
  ogTitle: ogTitleSchema,
  ogDescription: ogDescriptionSchema,
  ogImageKey: ogImageKeySchema,
  canonicalUrl: canonicalUrlSchema,
  noindex: noindexSchema,
} as const;

// -----------------------------------------------------------------------------
// Категории (§4.3).
// -----------------------------------------------------------------------------

export const CategoryCreateSchema = z.object({
  parentId: uuidSchema.nullish(),
  // Необязателен: если пуст — createCategory генерирует из name (slugify,
  // транслитерация кириллицы). Раньше был обязателен → создание категории с
  // пустым полем «Адрес» падало валидацией, в т.ч. для русских названий.
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).optional().default(''),
  sort: z.number().int().min(0).optional().default(0),
  isActive: z.boolean().optional().default(true),
  seoTitle,
  seoDescription,
});
export type CategoryCreateInput = z.infer<typeof CategoryCreateSchema>;

export const CategoryUpdateSchema = CategoryCreateSchema.partial().extend({
  id: uuidSchema,
  ...seoEntityFields,
});
export type CategoryUpdateInput = z.infer<typeof CategoryUpdateSchema>;

export const CategoryMoveSchema = z.object({
  id: uuidSchema,
  /** Новый родитель; null → перенести в корень. */
  parentId: uuidSchema.nullable(),
  sort: z.number().int().min(0).optional(),
});
export type CategoryMoveInput = z.infer<typeof CategoryMoveSchema>;

export const CategoryDeleteSchema = z.object({ id: uuidSchema });

// -----------------------------------------------------------------------------
// Товары (§4.2).
// -----------------------------------------------------------------------------

export const ProductCreateSchema = z
  .object({
    // Артикул необязателен: если пуст — createProduct генерирует его из
    // уникального slug (чтобы владелец не заполнял технический код вручную).
    sku: skuSchema.optional(),
    // Необязателен: если пуст — createProduct генерирует из name (slugify,
    // транслитерация кириллицы), как у брендов. Раньше был обязателен.
    slug: slugSchema.optional(),
    name: z.string().trim().min(1).max(255),
    description: z.string().max(50000).optional().default(''),
    status: z.enum(PRODUCT_STATUSES).optional().default('draft'),
    basePrice: moneySchema.optional().default('0'),
    // Акционные/каталожные расширения (docs/06 §3.1–§3.3, ADR-009):
    compareAtPrice: moneySchema.nullish(),
    isFeatured: z.boolean().optional().default(false),
    isNew: z.boolean().nullish(), // троичная логика: null=вычисляемо, true/false=override
    brandId: uuidSchema.nullish(),
    categoryIds: z.array(uuidSchema).optional().default([]),
    primaryCategoryId: uuidSchema.nullish(),
    seoTitle,
    seoDescription,
    ...dimensionFields,
  })
  .refine(
    (v) =>
      !v.primaryCategoryId ||
      (v.categoryIds?.includes(v.primaryCategoryId) ?? false),
    {
      message: 'primaryCategoryId должна входить в categoryIds',
      path: ['primaryCategoryId'],
    },
  );
export type ProductCreateInput = z.infer<typeof ProductCreateSchema>;

export const ProductUpdateSchema = z.object({
  id: uuidSchema,
  sku: skuSchema.optional(),
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(50000).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  basePrice: moneySchema.optional(),
  compareAtPrice: moneySchema.nullish(),
  isFeatured: z.boolean().optional(),
  isNew: z.boolean().nullish(),
  brandId: uuidSchema.nullish(),
  categoryIds: z.array(uuidSchema).optional(),
  primaryCategoryId: uuidSchema.nullish(),
  seoTitle,
  seoDescription,
  ...seoEntityFields,
  ...dimensionFields,
})
  // Зеркало refine из ProductCreateSchema: основная категория обязана входить в
  // список категорий товара (иначе syncProductCategories не пометит ни одну строку
  // is_primary=true → товар «имеет основную категорию, к которой не принадлежит»).
  // Правило срабатывает ТОЛЬКО когда заданы И primaryCategoryId, И categoryIds —
  // частичный апдейт, не трогающий категории (categoryIds === undefined), не ломаем.
  .superRefine((v, ctx) => {
    if (
      v.primaryCategoryId &&
      v.categoryIds !== undefined &&
      !v.categoryIds.includes(v.primaryCategoryId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryCategoryId'],
        message: 'primaryCategoryId должна входить в categoryIds',
      });
    }
  });
export type ProductUpdateInput = z.infer<typeof ProductUpdateSchema>;

export const ProductIdSchema = z.object({ id: uuidSchema });

/**
 * Массовая смена статуса товаров (массовые действия в списке).
 * ids — от 1 до 200 уникальных uuid (защита от слишком крупных UPDATE);
 * status — литерал из PRODUCT_STATUSES (CHECK-ограничение БД).
 */
export const BulkSetProductStatusSchema = z.object({
  ids: z.array(uuidSchema).min(1).max(200),
  status: z.enum(PRODUCT_STATUSES),
});
export type BulkSetProductStatusInput = z.infer<typeof BulkSetProductStatusSchema>;

/** Дублирование товара: id исходного товара. */
export const DuplicateProductSchema = z.object({ id: uuidSchema });
export type DuplicateProductInput = z.infer<typeof DuplicateProductSchema>;

// -----------------------------------------------------------------------------
// Варианты (§4.4).
// -----------------------------------------------------------------------------

export const VariantCreateSchema = z.object({
  productId: uuidSchema,
  // Артикул варианта необязателен: если пуст — createVariant генерирует
  // уникальный из названия/размера (владельцу достаточно ввести размер).
  sku: skuSchema.optional(),
  name: z.string().trim().max(255).optional().default(''),
  priceOverride: moneySchema.nullish(),
  priceDelta: moneySchema.optional().default('0'),
  compareAtPrice: moneySchema.nullish(),
  isActive: z.boolean().optional().default(true),
  sort: z.number().int().min(0).optional().default(0),
  ...dimensionFields,
});
export type VariantCreateInput = z.infer<typeof VariantCreateSchema>;

export const VariantUpdateSchema = z.object({
  id: uuidSchema,
  sku: skuSchema.optional(),
  name: z.string().trim().max(255).optional(),
  priceOverride: moneySchema.nullish(),
  priceDelta: moneySchema.optional(),
  compareAtPrice: moneySchema.nullish(),
  isActive: z.boolean().optional(),
  sort: z.number().int().min(0).optional(),
  ...dimensionFields,
});
export type VariantUpdateInput = z.infer<typeof VariantUpdateSchema>;

export const VariantIdSchema = z.object({ id: uuidSchema });

// -----------------------------------------------------------------------------
// Бренды (docs/06 §3.3, §4.3).
// -----------------------------------------------------------------------------

export const BrandCreateSchema = z.object({
  slug: slugSchema.optional(), // если пуст — сгенерируется из name (slugify)
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).optional().default(''),
  isActive: z.boolean().optional().default(true),
  sort: z.number().int().min(0).optional().default(0),
  seoTitle,
  seoDescription,
});
export type BrandCreateInput = z.infer<typeof BrandCreateSchema>;

export const BrandUpdateSchema = z.object({
  id: uuidSchema,
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  isActive: z.boolean().optional(),
  sort: z.number().int().min(0).optional(),
  seoTitle,
  seoDescription,
  ...seoEntityFields,
});
export type BrandUpdateInput = z.infer<typeof BrandUpdateSchema>;

export const BrandIdSchema = z.object({ id: uuidSchema });

/**
 * Загрузка логотипа бренда — как медиа товара: байты Buffer, тип/размер
 * реально проверяются validateUpload по magic-bytes (storage/validate).
 */
export const BrandLogoUploadSchema = z.object({
  brandId: uuidSchema,
  filename: z.string().max(255).optional().default('logo'),
  bytes: z.instanceof(Buffer),
});
export type BrandLogoUploadInput = z.infer<typeof BrandLogoUploadSchema>;

// -----------------------------------------------------------------------------
// Характеристики (§4.5).
// -----------------------------------------------------------------------------

export const AttributeCreateSchema = z.object({
  code: attributeCodeSchema,
  name: z.string().trim().min(1).max(255),
  type: z.enum(ATTRIBUTE_TYPES).optional().default('select'),
  unit: z.string().trim().max(32).nullish(),
  isVariant: z.boolean().optional().default(false),
  isFilterable: z.boolean().optional().default(true),
  isRequired: z.boolean().optional().default(false),
  sort: z.number().int().min(0).optional().default(0),
});
export type AttributeCreateInput = z.infer<typeof AttributeCreateSchema>;

export const AttributeUpdateSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(255).optional(),
  type: z.enum(ATTRIBUTE_TYPES).optional(),
  unit: z.string().trim().max(32).nullish(),
  isVariant: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  sort: z.number().int().min(0).optional(),
});
export type AttributeUpdateInput = z.infer<typeof AttributeUpdateSchema>;

export const AttributeValueSchema = z.object({
  attributeId: uuidSchema,
  value: z.string().trim().min(1).max(255),
  slug: slugSchema.nullish(),
  sort: z.number().int().min(0).optional().default(0),
});
export type AttributeValueInput = z.infer<typeof AttributeValueSchema>;

/** Одна привязка значения характеристики к товару/варианту. */
export const ProductAttributeItemSchema = z
  .object({
    attributeId: uuidSchema,
    variantId: uuidSchema.nullish(),
    /** Ссылка на словарь (для select). */
    valueId: uuidSchema.nullish(),
    /** Инлайн-значение (text/number/boolean). */
    valueText: z.string().max(1000).nullish(),
  })
  .refine((v) => Boolean(v.valueId) || Boolean(v.valueText), {
    message: 'нужно указать valueId (select) или valueText (text/number/boolean)',
    path: ['valueId'],
  });

export const SetProductAttributesSchema = z.object({
  productId: uuidSchema,
  items: z.array(ProductAttributeItemSchema),
});
export type SetProductAttributesInput = z.infer<
  typeof SetProductAttributesSchema
>;

// -----------------------------------------------------------------------------
// Медиа (§4.6).
// -----------------------------------------------------------------------------

/**
 * Вход загрузки медиа. Байты передаются как Buffer (Server Action принимает из
 * FormData/route). Тип/размер реально проверяются validateUpload по magic-bytes.
 */
export const MediaUploadSchema = z.object({
  productId: uuidSchema,
  variantId: uuidSchema.nullish(),
  /** Имя файла — только для диагностики, в ключ объекта НЕ попадает. */
  filename: z.string().max(255).optional().default('upload'),
  bytes: z.instanceof(Buffer),
  type: z.enum(MEDIA_TYPES).optional().default('image'),
  alt: z.string().max(255).optional().default(''),
  isPrimary: z.boolean().optional().default(false),
});
export type MediaUploadInput = z.infer<typeof MediaUploadSchema>;

export const MediaDeleteSchema = z.object({ id: uuidSchema });

export const MediaReorderSchema = z.object({
  productId: uuidSchema,
  /** Порядок id медиа; индекс в массиве → значение sort. */
  order: z.array(uuidSchema),
  /** Опционально назначить главное изображение. */
  primaryId: uuidSchema.nullish(),
});
export type MediaReorderInput = z.infer<typeof MediaReorderSchema>;

// -----------------------------------------------------------------------------
// Остатки (§4.7).
// -----------------------------------------------------------------------------

export const StockSetSchema = z.object({
  productId: uuidSchema,
  variantId: uuidSchema.nullish(),
  // m5: нормализуем к нижнему регистру — колонка warehouse_code citext (регистро-
  // независима в БД), а витринный показ сравнивает строкой; канонизация на входе
  // держит хранимые коды в одном регистре, чтобы показ совпадал с резервом/заказом.
  warehouseCode: z.string().trim().toLowerCase().min(1).max(64).optional().default('main'),
  /** Абсолютное значение остатка (≥0). */
  quantity: z.number().int().min(0),
});
export type StockSetInput = z.infer<typeof StockSetSchema>;

export const StockAdjustSchema = z
  .object({
    productId: uuidSchema,
    variantId: uuidSchema.nullish(),
    // m5: нормализуем к нижнему регистру — колонка warehouse_code citext (регистро-
  // независима в БД), а витринный показ сравнивает строкой; канонизация на входе
  // держит хранимые коды в одном регистре, чтобы показ совпадал с резервом/заказом.
  warehouseCode: z.string().trim().toLowerCase().min(1).max(64).optional().default('main'),
    /** Дельта изменения (может быть отрицательной); итог не уходит ниже 0. */
    delta: z.number().int(),
  })
  .refine((v) => v.delta !== 0, {
    message: 'delta не может быть 0',
    path: ['delta'],
  });
export type StockAdjustInput = z.infer<typeof StockAdjustSchema>;
