/**
 * Ошибки домена CMS (docs/11 §5.1.3).
 *
 * Вынесено в отдельный модуль (а не в actions.ts), потому что actions.ts будет
 * помечен директивой `'use server'`, а такой модуль может экспортировать ТОЛЬКО
 * async-функции (ограничение Next.js Server Actions). Класс ошибки — не функция,
 * поэтому живёт здесь (образец lib/catalog/errors.ts).
 */

/** Известные коды ошибок домена CMS. */
export type CmsErrorCode =
  | 'module_disabled' // модуль cms выключен (assertCmsEnabled)
  | 'not_found'
  | 'slug_conflict'
  | 'validation';

/** Ошибка домена CMS — маппится defineAction в error (или ловится вызывающим). */
export class CmsError extends Error {
  readonly code: CmsErrorCode;
  constructor(code: CmsErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'CmsError';
  }
}
