/**
 * Ошибки домена «Отзывы» (docs/24 §4).
 *
 * Вынесено в отдельный модуль (а не в actions.ts): actions.ts помечен `'use server'`
 * и может экспортировать ТОЛЬКО async-функции. Класс ошибки — не функция, поэтому
 * живёт здесь (образец lib/news/errors.ts).
 */

/** Известные коды ошибок домена «Отзывы». */
export type ReviewErrorCode =
  | 'module_disabled' // модуль reviews выключен (assertReviewsEnabled)
  | 'not_found'
  | 'product_not_found'
  | 'invalid_transition'
  | 'validation';

/** Ошибка домена «Отзывы» — маппится defineAction в error (или ловится вызывающим). */
export class ReviewError extends Error {
  readonly code: ReviewErrorCode;
  constructor(code: ReviewErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'ReviewError';
  }
}
