/**
 * Zod-схемы среза «Отзывы» (docs/24 §4).
 *
 * Обычный модуль (НЕ 'use server') — только схемы/типы; переиспользуется в
 * storefront-роуте (submit) и внутри admin Server Actions (модерация/ответ).
 *
 * SECURITY (public submit): ReviewSubmitSchema НЕ содержит полей status/is_verified/
 * customerId — их клиент выставить НЕ может (anti-tamper). Статус форсится сервером
 * в pending (репозиторий), customer резолвится по email из сессии/справочника, а не
 * из тела. rating — строго целое 1..5; body/authorName — ограничены по длине.
 */

import { z } from 'zod';

import { REVIEW_STATUSES } from './types';

/** UUID-идентификатор. */
export const uuidSchema = z.uuid();

/** Имя автора: непустое, до 120 символов. */
const authorNameSchema = z.string().trim().min(1).max(120);

/** Текст отзыва (UGC, plain). Санитизация — на сервере. До 4000 символов. */
const bodySchema = z.string().trim().min(1).max(4000);

/** Рейтинг: строго целое 1..5 (не число с плавающей точкой, не 0). */
const ratingSchema = z.number().int().min(1).max(5);

/**
 * Приём отзыва с витрины (public POST). Anti-tamper: НЕТ status/is_verified/
 * customerId — их выставляет сервер. email — опционально (резолв существующего
 * customer_id; гость → null). productId существование проверяет роут (404).
 */
export const ReviewSubmitSchema = z.object({
  productId: uuidSchema,
  authorName: authorNameSchema,
  body: bodySchema,
  rating: ratingSchema,
  /** Опц. email — для привязки к существующему покупателю (не создаёт нового). */
  email: z.string().trim().email().max(254).optional(),
});
export type ReviewSubmitInput = z.infer<typeof ReviewSubmitSchema>;

/** Статус отзыва (для фильтра списка модерации). */
export const reviewStatusSchema = z.enum(
  REVIEW_STATUSES as unknown as [string, ...string[]],
);

/** Вход смены статуса (модерация): id + целевой статус (из whitelist). */
export const ReviewStatusInputSchema = z.object({
  id: uuidSchema,
  status: reviewStatusSchema,
});
export type ReviewStatusInput = z.infer<typeof ReviewStatusInputSchema>;

/**
 * Вход ответа магазина: id + reply (nullable — очистка) + блок переводов reply.
 * reply — простой текст ответа магазина (до 4000). translations — грубая форма
 * `{ [locale]: { reply } }`, тонкая фильтрация whitelist×языки — на сервере.
 */
export const ReviewReplyInputSchema = z.object({
  id: uuidSchema,
  reply: z.string().trim().max(4000).nullable().optional(),
  translations: z
    .record(z.string(), z.record(z.string(), z.string()))
    .optional(),
});
export type ReviewReplyInput = z.infer<typeof ReviewReplyInputSchema>;

/** Идентификатор отзыва (delete). */
export const ReviewIdSchema = z.object({ id: uuidSchema });
export type ReviewIdInput = z.infer<typeof ReviewIdSchema>;

/** Фильтр списка модерации (статус/пагинация). */
export const ReviewListFilterSchema = z.object({
  status: reviewStatusSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(20),
});
export type ReviewListFilterInput = z.infer<typeof ReviewListFilterSchema>;
