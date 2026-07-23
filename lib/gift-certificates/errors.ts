/**
 * Доменные ошибки среза «Подарочные сертификаты» (docs/24 §5).
 *
 * Наследуют PublicActionError → message доходит до UI как доменная ошибка
 * (`error:'validation'`), а не «внутренняя ошибка». Поле `code` — машиночитаемо
 * (логи/тесты), не утекает в UI отдельно от текста.
 */
import { PublicActionError } from '@/lib/server/action';

/** Машиночитаемые коды отказов домена сертификатов. */
export type GiftErrorCode =
  | 'not_found'
  | 'expired'
  | 'depleted'
  | 'disabled'
  | 'inactive'
  | 'overspend'
  | 'invalid_amount'
  | 'face_below_spent'
  | 'duplicate_code'
  /** По этой позиции заказа сертификат уже выпущен (частичный UNIQUE 0054). */
  | 'duplicate_issue'
  | 'validation';

export class GiftCertificateError extends PublicActionError {
  readonly code: GiftErrorCode;
  constructor(code: GiftErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GiftCertificateError';
    Object.setPrototypeOf(this, GiftCertificateError.prototype);
  }
}

/** Остаток меньше запрошенного списания (или гонка guarded UPDATE) — откат транзакции. */
export class GiftOverspendError extends GiftCertificateError {
  constructor(message = 'Недостаточно средств на подарочном сертификате.') {
    super('overspend', message);
    this.name = 'GiftOverspendError';
    Object.setPrototypeOf(this, GiftOverspendError.prototype);
  }
}
