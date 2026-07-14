/**
 * Zod-схемы среза «Новости» (docs/24 §3).
 *
 * Обычный модуль (НЕ 'use server') — только схемы/типы; переиспользуется в
 * UI-формах и внутри Server Actions (единый источник правды о форме входа).
 *
 * Rich-text `body` валидируется здесь лишь как строка; СЕРВЕРНАЯ санитизация
 * (lib/news/sanitize.ts) применяется в Server Action перед записью — для базы и
 * для каждого языка оверлея. Переводы (title/excerpt/body/group/SEO) — блок
 * translations; тонкая фильтрация whitelist × включённые языки делается на сервере
 * (resolveTranslationsUpdate из lib/i18n).
 */

import { z } from 'zod';

import {
  seoTitleSchema,
  seoDescriptionSchema,
  ogTitleSchema,
  ogDescriptionSchema,
  canonicalUrlSchema,
  noindexSchema,
} from '@/lib/seo/schemas';
import { slugSchema } from '@/lib/catalog/schemas';
import { translationsBlockSchema } from '@/lib/i18n/write';

import { NEWS_STATUSES } from './types';

/** UUID-идентификатор. */
export const uuidSchema = z.string().uuid();

/** Заголовок: непустой, до 255 символов. */
const titleSchema = z.string().trim().min(1).max(255);

/** Рубрика/раздел: до 100 символов. */
const groupLabelSchema = z.string().trim().max(100);

/** Анонс: до 1000 символов (как в eAdmin). */
const excerptSchema = z.string().trim().max(1000);

/** Тело новости (rich HTML). Санитизация — на сервере, не здесь. */
const bodySchema = z.string().max(50000);

/** Ключ объекта в хранилище (S3). НЕ URL — URL собирает storage.publicUrl. */
const imageKeySchema = z.string().trim().max(512);

/** Дата публикации: ISO-строка → Date, либо null, либо отсутствует. */
const publishedAtSchema = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .nullable()
  .optional();

/** Статус новости — триада из CHECK БД (для фильтра списка). */
export const newsStatusSchema = z.enum(
  NEWS_STATUSES as unknown as [string, ...string[]],
);

/**
 * Редактируемый статус для create/update — ТОЛЬКО 'draft'/'archived'. Публикация
 * ('published') идёт отдельным действием setNewsStatus (проставляет published_at и
 * проходит машину статусов), а не обычным UPDATE.
 */
export const newsEditableStatusSchema = z.enum(['draft', 'archived']);

/** Общий фрагмент контентных/SEO-полей для create/update. */
const newsContentFields = {
  title: titleSchema,
  slug: slugSchema.optional(),
  groupLabel: groupLabelSchema.optional(),
  excerpt: excerptSchema.optional(),
  body: bodySchema.optional(),
  coverImageKey: imageKeySchema.optional(),
  publishedAt: publishedAtSchema,
  sortOrder: z.number().int().min(0).optional(),
  seoTitle: seoTitleSchema,
  seoDescription: seoDescriptionSchema,
  ogTitle: ogTitleSchema,
  ogDescription: ogDescriptionSchema,
  ogImageKey: imageKeySchema.optional(),
  canonicalUrl: canonicalUrlSchema,
  noindex: noindexSchema,
};

/** Создание новости: title обязателен, slug опционален (→ slugify(title)). */
export const NewsCreateSchema = z.object({
  ...newsContentFields,
  status: newsEditableStatusSchema.optional(),
});
export type NewsCreateInput = z.infer<typeof NewsCreateSchema>;

/** Обновление новости: id обязателен, поля частичны. */
export const NewsUpdateSchema = z.object({
  id: uuidSchema,
  ...newsContentFields,
  title: titleSchema.optional(),
  status: newsEditableStatusSchema.optional(),
  // Оверлей переводов { [locale]: { [field]: string } } — тонкая фильтрация в handler.
  translations: translationsBlockSchema,
});
export type NewsUpdateInput = z.infer<typeof NewsUpdateSchema>;

/** Идентификатор новости (delete). */
export const NewsIdSchema = z.object({ id: uuidSchema });
export type NewsIdInput = z.infer<typeof NewsIdSchema>;

/** Смена статуса (публикация/снятие/архивирование) — через машину статусов. */
export const NewsSetStatusSchema = z.object({
  id: uuidSchema,
  status: newsStatusSchema,
});
export type NewsSetStatusInput = z.infer<typeof NewsSetStatusSchema>;

/** Фильтр списка новостей (поиск/статус/пагинация — образец listCmsPages). */
export const NewsListFilterSchema = z.object({
  search: z.string().trim().optional(),
  status: newsStatusSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(20),
});
export type NewsListFilterInput = z.infer<typeof NewsListFilterSchema>;
