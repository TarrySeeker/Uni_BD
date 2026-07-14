/**
 * Доменные типы среза «Отзывы с рейтингом» (docs/24 §4).
 *
 * Типы прикладного уровня (camelCase), отображающие строки таблицы reviews.
 * Маппинг row(snake_case)→domain(camelCase) — в repository.ts (map*). Порт eAdmin
 * b_comments, коллапсированный под модель Admik: рейтинг 1..5, модерация как
 * статус-машина, FK на товар/покупателя.
 *
 * i18n: переводим ТОЛЬКО reply (ответ магазина). UGC (author_name/body) НЕ
 * переводим — по ADR (docs/24 §1, §4).
 */

import type { TranslationsMap } from '@/lib/i18n';

/** Модерационный статус отзыва (reviews.status). */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'pending',
  'approved',
  'rejected',
] as const;

/** Полный отзыв (для админ-карточки/модерации). */
export interface Review {
  id: string;
  productId: string;
  /** Профиль покупателя (null — гость). */
  customerId: string | null;
  /** Имя автора (UGC). НЕ переводимо. */
  authorName: string;
  /** Текст отзыва (UGC, plain-text после санитизации). НЕ переводимо. */
  body: string;
  /** Рейтинг 1..5. */
  rating: number;
  status: ReviewStatus;
  /** Ответ магазина. ПЕРЕВОДИМО (whitelist ['reply']). */
  reply: string | null;
  isVerified: boolean;
  source: string;
  /** Сырой jsonb-оверлей переводов (только reply). Резолв — в DTO/форме. */
  translations: TranslationsMap;
  createdAt: Date;
  publishedAt: Date | null;
  moderatedAt: Date | null;
  moderatedBy: string | null;
}

/**
 * Строка списка модерации (админ-таблица): отзыв + денормализованные поля товара
 * (имя/slug) через JOIN — чтобы модератор видел, к какому товару отзыв.
 */
export interface ReviewModerationRow extends Review {
  /** Имя товара (LEFT JOIN products). null — товар удалён (CASCADE не даст, но на всякий). */
  productName: string | null;
  /** Slug товара (для ссылки на витрину/карточку). */
  productSlug: string | null;
}

/** Витринная строка одобренного отзыва (без внутренних полей). */
export interface ApprovedReviewRow {
  id: string;
  authorName: string;
  body: string;
  rating: number;
  reply: string | null;
  translations: TranslationsMap;
  createdAt: Date;
  publishedAt: Date | null;
}

/** Агрегат рейтинга товара (только по approved). */
export interface ReviewAggregate {
  /** Средний рейтинг (0, если отзывов нет). */
  average: number;
  /** Число одобренных отзывов. */
  count: number;
  /** Распределение по звёздам 1..5. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}
