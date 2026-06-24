/**
 * Ошибки домена каталога.
 *
 * Вынесено в отдельный модуль (а не в actions.ts), потому что actions.ts помечен
 * директивой `'use server'`, а такой модуль может экспортировать ТОЛЬКО async-функции
 * (ограничение Next.js Server Actions). Класс ошибки — не функция, поэтому живёт здесь.
 */

import { PublicActionError } from '@/lib/server/action';

/**
 * Ошибка домена каталога.
 *
 * НАСЛЕДУЕТ PublicActionError (lib/server/action.ts) — как OrderError
 * (lib/orders/errors.ts) — чтобы человекочитаемый `message` доходил до UI:
 * пайплайн defineAction маппит `instanceof PublicActionError` в
 * `{ ok:false, error:'validation', message }`. Раньше CatalogError наследовал
 * обычный Error → пайплайн превращал ЛЮБОЙ бизнес-отказ каталога в безликий
 * `error:'internal'` без текста, и владелец видел «внутреннюю ошибку» вместо
 * понятной доменной причины («Категория не найдена», «Нельзя переместить
 * категорию внутрь её собственного поддерева», «Недостаточно остатка», «Модуль
 * выключен» и т.п.). Все сообщения каталога безопасны для UI (без секретов).
 *
 * Поле `code` сохраняет машиночитаемый код домена (not_found / cycle /
 * slug_conflict / insufficient_stock / invalid_media / storage_failed /
 * module_disabled / ...) для логов и тестов — он не утекает в UI отдельно от
 * текста сообщения.
 */
export class CatalogError extends PublicActionError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CatalogError';
    Object.setPrototypeOf(this, CatalogError.prototype);
  }
}
