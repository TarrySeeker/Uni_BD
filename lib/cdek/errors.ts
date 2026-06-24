/**
 * Ошибки модуля cdek (docs/08 §2 «errors.ts», порт carre Exception.php).
 *
 * Вынесено в отдельный модуль (как lib/catalog/errors.ts), потому что actions.ts
 * помечен `'use server'` и может экспортировать только async-функции. Класс
 * ошибки — не функция, поэтому живёт здесь.
 *
 * CdekError несёт:
 *   * code     — машинный код (наш или код ошибки СДЭК);
 *   * message  — человекочитаемое сообщение;
 *   * cdekErrors — массив структурированных ошибок из тела ответа СДЭК (опц.);
 *   * httpStatus — HTTP-статус ответа СДЭК (опц.).
 */

/** Одна структурированная ошибка из тела ответа СДЭК (`errors[]`). */
export interface CdekApiError {
  code: string;
  message: string;
}

/** Ошибка взаимодействия с СДЭК / домена cdek. */
export class CdekError extends Error {
  readonly code: string;
  readonly cdekErrors: CdekApiError[];
  readonly httpStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { cdekErrors?: CdekApiError[]; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = 'CdekError';
    this.code = code;
    this.cdekErrors = options.cdekErrors ?? [];
    this.httpStatus = options.httpStatus ?? null;
  }
}
