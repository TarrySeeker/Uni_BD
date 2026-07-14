/**
 * Ошибки модуля payments/paykeeper (порт lib/payments/tbank/errors.ts).
 *
 * Вынесено в отдельный модуль — service.ts может экспортировать только async-
 * функции, класс ошибки живёт здесь.
 *
 * PaykeeperError несёт:
 *   * code               — машинный код (наш);
 *   * message            — человекочитаемое сообщение;
 *   * paykeeperErrorCode — код/поле ошибки из тела ответа PayKeeper (опц.);
 *   * httpStatus         — HTTP-статус ответа (опц.).
 */

/** Ошибка взаимодействия с PayKeeper / домена payments. */
export class PaykeeperError extends Error {
  readonly code: string;
  readonly paykeeperErrorCode: string | null;
  readonly httpStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { paykeeperErrorCode?: string | null; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = 'PaykeeperError';
    this.code = code;
    this.paykeeperErrorCode = options.paykeeperErrorCode ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}
