/**
 * Маппинг статусов АТОЛ Pay → orders.payment_status.
 * ЧИСТАЯ, без сети/БД (по образцу lib/payments/ozon/status-map.ts).
 *
 * У АТОЛа статус платежа — ЧИСЛО (`paymentStatus` 0..12), один словарь и для
 * ответа API, и для callback. Существующий PaymentStatus
 * (pending|authorized|paid|failed|refunded) покрывает все исходы — новых
 * значений в БД не требуется.
 *
 * 🔴 НЕ ПУТАТЬ С ПОЛЕМ `status`. Рядом в теле приходит `status`
 * («success»|«fail»|«error») — это статус ОБРАБОТКИ ЗАПРОСА, а не оплаты: в
 * примере документации `status: "success"` соседствует с `paymentStatus: 0`
 * («в обработке»). Факт оплаты определяется ТОЛЬКО числовым paymentStatus.
 */

import type { PaymentStatus } from '@/lib/orders/types';
import { ATOL_PAYMENT_STATUS } from './types';

/**
 * Числовой статус платежа → payment_status.
 *
 * НАМЕРЕННО не маппятся (→ null, событие логируется, решает оператор):
 *   • partialCancel (7) / partialRefund (8) — ЧАСТИЧНЫЙ возврат: авто-переход
 *     в refunded закрыл бы заказ целиком и высвободил ВЕСЬ резерв остатков,
 *     хотя вернулась лишь часть денег (этот баг уже лечили в Т-Банке);
 *   • notResponding (2) / retryError (12) — исход НЕИЗВЕСТЕН, повтор возможен.
 *     Пометить failed = отпустить резерв под платёж, который ещё может пройти.
 */
export const PAYMENT_STATUS_TO_ORDER: Readonly<Record<number, PaymentStatus>> = {
  [ATOL_PAYMENT_STATUS.processing]: 'pending',
  // 3DS ещё подтверждается — исход не определён.
  [ATOL_PAYMENT_STATUS.confirm3ds]: 'pending',
  // Двухстадийная: деньги захолдированы, но НЕ списаны. Это не «оплачено».
  [ATOL_PAYMENT_STATUS.awaitingDeposit]: 'authorized',
  [ATOL_PAYMENT_STATUS.success]: 'paid',
  [ATOL_PAYMENT_STATUS.error]: 'failed',
  [ATOL_PAYMENT_STATUS.canceled]: 'failed',
  [ATOL_PAYMENT_STATUS.fraud]: 'failed',
  [ATOL_PAYMENT_STATUS.paymentIsOverdue]: 'failed',
  // Полный возврат — терминальный сетл (освобождение резерва, откат промокода).
  [ATOL_PAYMENT_STATUS.refunded]: 'refunded',
};

/**
 * Числовой статус платежа → payment_status, либо null если авто-переход не нужен.
 *
 * 🔴 Тип проверяется СТРОГО: строка «1» вместо числа 1 не считается оплатой.
 * На нестрогом приведении уже горели с Озоном (рубли-строка вместо копеек).
 * 🔴 Статус 0 — ЗНАЧАЩИЙ («в обработке»), отбрасывать его как falsy нельзя.
 */
export function mapPaymentStatus(status: number | undefined | null): PaymentStatus | null {
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  return PAYMENT_STATUS_TO_ORDER[status] ?? null;
}

/** Расшифровки числовых статусов — для журнала и разбора обращений покупателей. */
export const STATUS_LABELS: Readonly<Record<number, string>> = {
  [ATOL_PAYMENT_STATUS.processing]: 'в обработке',
  [ATOL_PAYMENT_STATUS.success]: 'успех (выполнен)',
  [ATOL_PAYMENT_STATUS.notResponding]: 'банк не ответил',
  [ATOL_PAYMENT_STATUS.error]: 'ошибка, повтор невозможен',
  [ATOL_PAYMENT_STATUS.canceled]: 'отменён',
  [ATOL_PAYMENT_STATUS.refunded]: 'возвращён',
  [ATOL_PAYMENT_STATUS.fraud]: 'подозрение в мошенничестве',
  [ATOL_PAYMENT_STATUS.partialCancel]: 'частичная отмена',
  [ATOL_PAYMENT_STATUS.partialRefund]: 'частично возвращён',
  [ATOL_PAYMENT_STATUS.paymentIsOverdue]: 'платёж просрочен',
  [ATOL_PAYMENT_STATUS.confirm3ds]: 'подтверждение 3DS',
  [ATOL_PAYMENT_STATUS.awaitingDeposit]: 'ожидает списания (2-стадийная)',
  [ATOL_PAYMENT_STATUS.retryError]: 'ошибка, повтор возможен',
};

/** Человекочитаемое описание числового статуса платежа. */
export function describeAtolStatus(status: number | undefined | null): string | null {
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  return STATUS_LABELS[status] ?? `неизвестный статус ${status}`;
}

/** Расшифровки строковых кодов ошибок API. */
export const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  // 🔴 Первое, что проверять при AUTH_ERROR: документ АТОЛа (стр. 14) предписывает
  // заголовок без «Bearer», и именно так приходит 403. Нужен `Bearer <token>`.
  AUTH_ERROR: 'неверный токен (нужен заголовок «Bearer <token>»)',
  NO_AUTH_DATA: 'токен не передан',
  USER_NOT_FOUND: 'пользователь не найден',
  PERMISSION_DENIED: 'доступ запрещён',
  BANK_SETTINGS_NOT_FOUND: 'не настроен банк-эквайер в ЛК АТОЛа',
  CARD_NOT_FOUND: 'карта не найдена',
  INVALID_ORDER_ID: 'недопустимый идентификатор заказа',
  PAYMENT_NOT_FOUND: 'платёж не найден',
  PAYMENT_PROCESSED: 'платёж уже обработан',
  PAYMENT_EXISTS: 'платёж с таким orderId уже зарегистрирован',
  INVALID_RECEIPT_AMOUNT: 'сумма платежа не сошлась с суммой позиций чека',
  UNEXPECTED_REGISTER_PAYMENT_ERROR: 'непредвиденная ошибка регистрации платежа',
};

/** Человекочитаемое описание кода ошибки API. */
export function describeErrorCode(code: string | undefined | null): string | null {
  if (!code) return null;
  return ERROR_CODE_LABELS[code] ?? `неизвестный код ${code}`;
}
