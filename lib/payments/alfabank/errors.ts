/**
 * Ошибки модуля payments/alfabank (порт lib/payments/paykeeper/errors.ts).
 *
 * Вынесено в отдельный модуль — service.ts может экспортировать только async-
 * функции, класс ошибки живёт здесь.
 *
 * AlfabankError несёт:
 *   * code              — машинный код (наш);
 *   * message           — человекочитаемое сообщение;
 *   * alfabankErrorCode — errorCode из тела ответа Альфа-Банка (опц.);
 *   * httpStatus        — HTTP-статус ответа (опц.).
 */

/** Ошибка взаимодействия с Альфа-Банком / домена payments. */
export class AlfabankError extends Error {
  readonly code: string;
  readonly alfabankErrorCode: string | null;
  readonly httpStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { alfabankErrorCode?: string | null; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = 'AlfabankError';
    this.code = code;
    this.alfabankErrorCode = options.alfabankErrorCode ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}
