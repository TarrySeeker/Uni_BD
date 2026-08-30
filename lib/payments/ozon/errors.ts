/** Ошибка Ozon Acquiring с кодом из тела ответа (не HTTP-статусом). */
export class OzonError extends Error {
  readonly code: number | null;
  readonly httpStatus: number | null;
  readonly requestId: string | null;

  constructor(message: string, opts: { code?: number | null; httpStatus?: number | null; requestId?: string | null } = {}) {
    super(message);
    this.name = "OzonError";
    this.code = opts.code ?? null;
    this.httpStatus = opts.httpStatus ?? null;
    this.requestId = opts.requestId ?? null;
  }

  /**
   * Код 16 (Unauthenticated) — В ТОМ ЧИСЛЕ неверная подпись запроса.
   * Отдаётся с HTTP 400, поэтому по статусу его не отличить от ошибки данных.
   */
  get isAuthError(): boolean {
    return this.code === 16;
  }

  /** Код 5 — сущность не найдена. */
  get isNotFound(): boolean {
    return this.code === 5;
  }

  /** Транзиентные ошибки на стороне Ozon — имеет смысл повторить. */
  get isRetryable(): boolean {
    return this.code === 2 || this.code === 13 || (this.httpStatus !== null && this.httpStatus >= 500);
  }
}
