/**
 * Ошибки домена настроек магазина (docs/11 §5.4).
 *
 * Вынесено в отдельный модуль (а не в actions.ts), потому что actions.ts помечен
 * директивой `'use server'`, а такой модуль может экспортировать ТОЛЬКО async-функции
 * (ограничение Next.js Server Actions). Класс ошибки — не функция, поэтому живёт здесь
 * (тот же приём, что и lib/catalog/errors.ts).
 */

/** Ошибка домена настроек — маппится defineAction в error:'internal' (или ловится вызывающим). */
export class SettingsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SettingsError';
  }
}
