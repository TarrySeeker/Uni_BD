/**
 * Ошибки домена дизайнеров.
 *
 * Отдельный модуль (не в actions.ts): actions.ts помечен 'use server' и может
 * экспортировать только async-функции. Класс наследует PublicActionError, чтобы
 * человекочитаемый message доходил до UI (как CatalogError), см. lib/catalog/errors.
 */

import { PublicActionError } from '@/lib/server/action';

export class DesignerError extends PublicActionError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DesignerError';
    Object.setPrototypeOf(this, DesignerError.prototype);
  }
}
