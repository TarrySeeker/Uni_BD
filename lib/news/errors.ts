/**
 * Ошибки домена «Новости» (docs/24 §3).
 *
 * Вынесено в отдельный модуль (а не в actions.ts): actions.ts помечен `'use server'`
 * и может экспортировать ТОЛЬКО async-функции. Класс ошибки — не функция, поэтому
 * живёт здесь (образец lib/cms/errors.ts).
 */

/** Известные коды ошибок домена «Новости». */
export type NewsErrorCode =
  | 'module_disabled' // модуль news выключен (assertNewsEnabled)
  | 'not_found'
  | 'slug_conflict'
  | 'invalid_transition'
  | 'validation';

/** Ошибка домена «Новости» — маппится defineAction в error (или ловится вызывающим). */
export class NewsError extends Error {
  readonly code: NewsErrorCode;
  constructor(code: NewsErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'NewsError';
  }
}
