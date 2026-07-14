/**
 * Публичные DTO отзывов для Storefront API (docs/24 §4, ADR-i18n docs/24 §1).
 *
 * ПРИНЦИП (как news-dto): витрине отдаём ТОЛЬКО публично-безопасные поля. СКРЫВАЕМ:
 * id, customerId, email, status, source, is_verified, moderated_*, timestamps
 * (кроме createdAt), сырой translations. Отдаём: authorName, rating, body,
 * reply (locale-resolved), createdAt.
 *
 * i18n: переводим ТОЛЬКО reply (whitelist ['reply']). UGC (authorName/body) НЕ
 * локализуется — остаётся на языке автора (по ADR). ФОРМА DTO не меняется.
 *
 * Чистые функции — тестируемы без БД/Next.
 */

import { REVIEW_TRANSLATABLE_FIELDS } from '@/lib/reviews/fields';
import type { ApprovedReviewRow, ReviewAggregate } from '@/lib/reviews/types';
import { localizeEntity, type LocalizeCtx } from './locale';

/** Публичный отзыв (для GET /reviews). */
export interface PublicReviewDto {
  id: string;
  authorName: string;
  rating: number;
  body: string;
  /** Ответ магазина (локализован по ctx.locale). null — ответа нет. */
  reply: string | null;
  createdAt: string;
}

/** Публичный агрегат рейтинга товара. */
export interface PublicReviewAggregateDto {
  /** Средний рейтинг, округлён до 1 знака (0 — отзывов нет). */
  average: number;
  count: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/** Строка одобренного отзыва (домен) → публичный DTO (reply локализован). */
export function toPublicReviewDto(
  row: ApprovedReviewRow,
  loc?: LocalizeCtx,
): PublicReviewDto {
  // Локализуем ТОЛЬКО reply (whitelist). authorName/body не трогаем.
  const l = localizeEntity(row, REVIEW_TRANSLATABLE_FIELDS, loc);
  return {
    id: l.id,
    authorName: l.authorName,
    rating: l.rating,
    body: l.body,
    reply: l.reply,
    createdAt: (l.publishedAt ?? l.createdAt).toISOString(),
  };
}

/** Агрегат рейтинга (домен) → публичный DTO (average до 1 знака). */
export function toReviewAggregateDto(
  agg: ReviewAggregate,
): PublicReviewAggregateDto {
  return {
    average: Math.round(agg.average * 10) / 10,
    count: agg.count,
    distribution: {
      '1': agg.distribution[1],
      '2': agg.distribution[2],
      '3': agg.distribution[3],
      '4': agg.distribution[4],
      '5': agg.distribution[5],
    },
  };
}
