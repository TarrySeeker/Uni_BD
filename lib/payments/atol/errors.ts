/** Ошибка АТОЛ Pay с кодом из тела ответа (у АТОЛа код ТЕКСТОВЫЙ, не числовой). */

import { ATOL_ERROR_CODES } from './types';

export class AtolError extends Error {
  readonly code: string | null;
  readonly httpStatus: number | null;

  constructor(message: string, opts: { code?: string | null; httpStatus?: number | null } = {}) {
    super(message);
    this.name = 'AtolError';
    this.code = opts.code ?? null;
    this.httpStatus = opts.httpStatus ?? null;
  }

  /**
   * Неверный или непереданный токен.
   *
   * 🔴 Первое, что проверять при этой ошибке, — формат заголовка. Документация
   * АТОЛа (стр. 14) предписывает `Authorization: <token>`, и ровно так приходит
   * 403 AUTH_ERROR. Рабочий вариант — `Authorization: Bearer <token>`
   * (проверено живым запросом к боевому API 15.09.2026).
   */
  get isAuthError(): boolean {
    return this.code === ATOL_ERROR_CODES.authError || this.code === ATOL_ERROR_CODES.noAuthData;
  }

  /** Платёж не найден на стороне АТОЛа. */
  get isNotFound(): boolean {
    return this.code === ATOL_ERROR_CODES.paymentNotFound;
  }

  /**
   * Платёж с таким orderId уже зарегистрирован. Это НЕ сбой: так выглядит
   * повторная инициация оплаты того же заказа (покупатель вернулся к оплате).
   */
  get isAlreadyExists(): boolean {
    return this.code === ATOL_ERROR_CODES.paymentExists;
  }

  /**
   * Сумма платежа не сошлась с суммой позиций чека.
   * Признак ошибки в НАШЕЙ арифметике, а не на стороне банка (см. money.ts).
   */
  get isReceiptAmountMismatch(): boolean {
    return this.code === ATOL_ERROR_CODES.invalidReceiptAmount;
  }

  /** Транзиентные сбои — имеет смысл повторить. */
  get isRetryable(): boolean {
    if (this.code === ATOL_ERROR_CODES.paymentNotFound) return false;
    if (this.isAuthError) return false;
    return this.httpStatus === null || this.httpStatus >= 500 || this.httpStatus === 429;
  }
}
