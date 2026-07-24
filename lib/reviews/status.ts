/**
 * Машина статусов отзыва как ДАННЫЕ (docs/24 §4). Модерация:
 *   pending  → approved | rejected      (первичное решение модератора)
 *   approved → rejected | pending        (снять с публикации / вернуть в очередь)
 *   rejected → approved | pending        (переоценить)
 * X → X запрещён (нет «нулевых» переходов). Чистый модуль — тестируется без БД.
 *
 * Синхронизировано с CHECK таблицы reviews (0043_reviews.sql):
 *   pending | approved | rejected.
 */

import type { ReviewStatus } from './types';

/** Карта допустимых переходов статуса отзыва. */
export const REVIEW_STATUS_TRANSITIONS: Readonly<
  Record<ReviewStatus, readonly ReviewStatus[]>
> = {
  pending: ['approved', 'rejected'],
  approved: ['rejected', 'pending'],
  rejected: ['approved', 'pending'],
};

/** Человекочитаемые подписи статусов (для бейджей/кнопок админки). */
// Значения — i18n-КЛЮЧИ (волна 6-Б); русские подписи живут в messages/ru.json.
export const REVIEW_STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  pending: 'reviews.statuses.pending',
  approved: 'reviews.statuses.approved',
  rejected: 'reviews.statuses.rejected',
};

/** True, если строка — известный статус отзыва. */
export function isReviewStatus(value: unknown): value is ReviewStatus {
  return (
    typeof value === 'string' &&
    (['pending', 'approved', 'rejected'] as string[]).includes(value)
  );
}

/** Подпись статуса (фолбэк — сама строка, если статус неизвестен). */
export function reviewStatusLabel(
  status: string,
  t: (key: string) => string,
): string {
  return isReviewStatus(status) ? t(REVIEW_STATUS_LABELS[status]) : status;
}

/** true, если переход from→to допустим машиной статусов (X→X запрещён). */
export function canReviewTransition(from: string, to: string): boolean {
  if (!isReviewStatus(from) || !isReviewStatus(to)) return false;
  return REVIEW_STATUS_TRANSITIONS[from].includes(to);
}

/** Список статусов, в которые можно перейти из текущего (для UI-кнопок). */
export function nextReviewStatuses(from: string): ReviewStatus[] {
  if (!isReviewStatus(from)) return [];
  return [...REVIEW_STATUS_TRANSITIONS[from]];
}
