/**
 * Zod-схемы входа для Server Actions дизайнеров (§9, ADR §4.4).
 *
 * Зеркало Brand*Schema (lib/catalog/schemas): один источник правды о форме входа,
 * переиспользуется формой админки. Все мутации валидируются внутри defineAction.
 */

import { z } from 'zod';

import {
  ogTitleSchema,
  ogDescriptionSchema,
  ogImageKeySchema,
  canonicalUrlSchema,
  noindexSchema,
} from '@/lib/seo/schemas';
import { translationsBlockSchema } from '@/lib/i18n/write';

/** UUID-идентификатор. */
export const uuidSchema = z.string().uuid();

/** Строгий slug (совпадает с выходом slugify). */
export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'slug: только латиница в нижнем регистре, цифры и дефисы (без двойных/краевых дефисов)',
  );

const seoTitle = z.string().max(255).optional();
const seoDescription = z.string().max(1000).optional();

/** Расширенные SEO/OG-поля (docs/11 §5.3), как у бренда. */
const seoEntityFields = {
  ogTitle: ogTitleSchema,
  ogDescription: ogDescriptionSchema,
  ogImageKey: ogImageKeySchema,
  canonicalUrl: canonicalUrlSchema,
  noindex: noindexSchema,
} as const;

/** Соцсети: словарь ссылок { fb, inst, ... }. Пустой словарь допустим. */
export const socialsSchema = z.record(z.string(), z.string().max(500)).optional();

const videoUrlSchema = z.string().max(1000).optional();
const countrySchema = z.string().max(255).optional();

export const DesignerCreateSchema = z.object({
  slug: slugSchema.optional(), // если пуст — сгенерируется из name (slugify)
  name: z.string().trim().min(1).max(255),
  country: countrySchema,
  description: z.string().max(50000).optional().default(''),
  videoUrl: videoUrlSchema,
  socials: socialsSchema,
  workCount: z.number().int().min(0).optional().default(0),
  isActive: z.boolean().optional().default(true),
  sort: z.number().int().min(0).optional().default(0),
  seoTitle,
  seoDescription,
});
export type DesignerCreateInput = z.infer<typeof DesignerCreateSchema>;

export const DesignerUpdateSchema = z.object({
  id: uuidSchema,
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(255).optional(),
  country: countrySchema,
  description: z.string().max(50000).optional(),
  videoUrl: videoUrlSchema,
  socials: socialsSchema,
  workCount: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  sort: z.number().int().min(0).optional(),
  seoTitle,
  seoDescription,
  ...seoEntityFields,
  // Оверлей переводов (ADR-i18n): { [locale]: { name|description|country } }.
  translations: translationsBlockSchema,
});
export type DesignerUpdateInput = z.infer<typeof DesignerUpdateSchema>;

export const DesignerIdSchema = z.object({ id: uuidSchema });

export const DesignerSetActiveSchema = z.object({
  id: uuidSchema,
  isActive: z.boolean(),
});

/**
 * Загрузка аватара дизайнера — как медиа товара/лого бренда: байты Buffer,
 * тип/размер проверяются validateUpload по magic-bytes.
 */
export const DesignerImageUploadSchema = z.object({
  designerId: uuidSchema,
  filename: z.string().max(255).optional().default('avatar'),
  bytes: z.instanceof(Buffer),
});
export type DesignerImageUploadInput = z.infer<typeof DesignerImageUploadSchema>;
