/**
 * Zod-схемы входа для Server Actions структурных секций товара (product_blocks, §9).
 *
 * Один источник правды о форме входа; переиспользуется редактором секций на карточке
 * товара. Все мутации валидируются внутри defineAction (catalog.write).
 *
 * i18n: плоские переводимые поля (title/blockquot/body) + СТРУКТУРНЫЙ перевод табов
 * (translations[locale].tabs). translationsBlockSchema домена (blockTranslationsSchema)
 * пропускает ТОЛЬКО whitelist-поля и включённые языки — тонкая фильтрация языков
 * (минус defaultLocale) делается в action по runtime-конфигу магазина.
 */

import { z } from 'zod';

import { PRODUCT_BLOCK_TYPES } from './types';

/** UUID-идентификатор. */
export const uuidSchema = z.string().uuid();

/** Максимальная длина одного текстового поля секции (rich HTML тоже влезает). */
const MAX_LEN = 20000;
/** Максимум табов на секцию (порт tab_one..four). */
export const MAX_TABS = 4;

/** Тип секции (нормализованный enum). */
export const ProductBlockTypeSchema = z.enum(
  PRODUCT_BLOCK_TYPES as unknown as [string, ...string[]],
);

/** Один таб: имя + текст (оба опциональны; пустые допустимы для частичного перевода). */
export const blockTabSchema = z.object({
  name: z.string().max(MAX_LEN).optional().default(''),
  text: z.string().max(MAX_LEN).optional().default(''),
});

/** Массив табов (не более MAX_TABS). */
export const blockTabsSchema = z.array(blockTabSchema).max(MAX_TABS);

/**
 * Оверлей переводов ОДНОГО языка секции: плоские поля + структурные табы.
 * `strip` (по умолчанию) отсекает поля вне whitelist. Табы валидируются той же
 * blockTabsSchema (structured).
 */
export const blockLocaleOverlaySchema = z.object({
  title: z.string().max(MAX_LEN).optional(),
  blockquot: z.string().max(MAX_LEN).optional(),
  body: z.string().max(MAX_LEN).optional(),
  tabs: blockTabsSchema.optional(),
}); // strip (по умолчанию): поля вне whitelist молча отсекаются

/**
 * Строит схему блока переводов секции по включённым (не-дефолтным) языкам:
 * `{ [locale]: { title?, blockquot?, body?, tabs? } }`. Ключи вне `locales`
 * отсекаются (strip). Пригодно как значение колонки translations.
 */
export function blockTranslationsSchema(
  locales: readonly string[],
): z.ZodType<Record<string, z.infer<typeof blockLocaleOverlaySchema>>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const locale of locales) {
    shape[locale] = blockLocaleOverlaySchema.optional();
  }
  return z.object(shape) as unknown as z.ZodType<
    Record<string, z.infer<typeof blockLocaleOverlaySchema>>
  >;
}

/**
 * Вход upsert секции (create при отсутствии id, update при наличии). Грубая форма
 * translations — карта карт (тонкая фильтрация whitelist/языков — в action через
 * blockTranslationsSchema с runtime-конфигом языков).
 */
export const UpsertProductBlockSchema = z.object({
  id: uuidSchema.optional(),
  productId: uuidSchema,
  type: ProductBlockTypeSchema,
  title: z.string().max(MAX_LEN).nullish(),
  blockquot: z.string().max(MAX_LEN).nullish(),
  authorDesignerId: uuidSchema.nullish(),
  body: z.string().max(MAX_LEN).nullish(),
  imageKey: z.string().max(1024).nullish(),
  tabs: blockTabsSchema.optional().default([]),
  sort: z.number().int().min(0).optional(),
  // Грубая форма: { [locale]: { [field]: unknown } }; тонко валидируется в action.
  translations: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export type UpsertProductBlockInput = z.infer<typeof UpsertProductBlockSchema>;

/** Переупорядочивание секций товара: полный порядок id. */
export const ReorderProductBlocksSchema = z.object({
  productId: uuidSchema,
  order: z.array(uuidSchema),
});
export type ReorderProductBlocksInput = z.infer<typeof ReorderProductBlocksSchema>;

/** Идентификатор секции (delete). */
export const ProductBlockIdSchema = z.object({ id: uuidSchema });

/**
 * Загрузка картинки секции — как медиа товара/аватар дизайнера: байты Buffer,
 * тип/размер проверяются validateUpload по magic-bytes.
 */
export const ProductBlockImageUploadSchema = z.object({
  blockId: uuidSchema,
  filename: z.string().max(255).optional().default('block'),
  bytes: z.instanceof(Buffer),
});
export type ProductBlockImageUploadInput = z.infer<typeof ProductBlockImageUploadSchema>;
