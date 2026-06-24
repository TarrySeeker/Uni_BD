/**
 * Ошибки модуля payments/tbank (docs/15 §2 «errors.ts», порт CdekError).
 *
 * Вынесено в отдельный модуль (как lib/cdek/errors.ts) — service.ts может быть
 * помечен `'use server'` и экспортировать только async-функции; класс ошибки
 * живёт здесь.
 *
 * TbankError несёт:
 *   * code           — машинный код (наш или код ошибки Т-Банка);
 *   * message        — человекочитаемое сообщение;
 *   * tbankErrorCode — ErrorCode из тела ответа Т-Банка (опц.);
 *   * httpStatus     — HTTP-статус ответа (опц.).
 */

/** Ошибка взаимодействия с Т-Банком / домена payments. */
export class TbankError extends Error {
  readonly code: string;
  readonly tbankErrorCode: string | null;
  readonly httpStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { tbankErrorCode?: string | null; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = 'TbankError';
    this.code = code;
    this.tbankErrorCode = options.tbankErrorCode ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}
