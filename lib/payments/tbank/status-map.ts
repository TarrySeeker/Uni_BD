/**
 * Маппинг Status Т-Банка → orders.payment_status Admik (docs/15 §4.3, порт
 * lib/cdek/services/status-map.ts). ЧИСТАЯ, без сети/БД — всегда зелёная.
 *
 * Существующий PaymentStatus (pending|authorized|paid|failed|refunded) уже
 * покрывает все исходы Т-Банка — новых значений в БД НЕ требуется (docs/15 §4.3):
 *   AUTHORIZED (hold двухстадийной) ровно соответствует `authorized`.
 *
 * | Т-Банк Status                          | payment_status |
 * |----------------------------------------|----------------|
 * | NEW, FORM_SHOWED, AUTHORIZING          | pending        |
 * | AUTHORIZED                             | authorized     |
 * | CONFIRMING                             | authorized     |
 * | CONFIRMED                              | paid           |
 * | REJECTED, DEADLINE_EXPIRED, REVERSED,  | failed         |
 * |   REVERSING, CANCELED                  |                |
 * | REFUNDED, PARTIAL_REFUNDED, REFUNDING  | refunded       |
 */

import type { PaymentStatus } from '@/lib/orders/types';
import type { TbankStatus } from './types';

/** Полная таблица соответствия Status Т-Банка → payment_status Admik. */
export const STATUS_TO_PAYMENT_STATUS: Readonly<Record<string, PaymentStatus>> = {
  // Платёж создан / форма показана / авторизуется — ещё ждём (pending).
  NEW: 'pending',
  FORM_SHOWED: 'pending',
  AUTHORIZING: 'pending',

  // Двухстадийная: средства захолдированы (hold) — authorized, ждём Confirm.
  AUTHORIZED: 'authorized',
  CONFIRMING: 'authorized',

  // Списание подтверждено — оплачено.
  CONFIRMED: 'paid',

  // Отказ / истёк срок / отмена холда / реверс — провал.
  REJECTED: 'failed',
  DEADLINE_EXPIRED: 'failed',
  REVERSING: 'failed',
  REVERSED: 'failed',
  CANCELED: 'failed',

  // Возврат. ТОЛЬКО полный REFUNDED → 'refunded' (терминальный сетл: освобождение
  // резерва + откат промокода + order.status='refunded', см. settleRefundEffectsTx).
  // REFUNDING (возврат В ПРОЦЕССЕ — деньги ещё НЕ вернулись) и PARTIAL_REFUNDED
  // (частичный возврат) НАМЕРЕННО не в карте → null: иначе транзиентный/частичный
  // возврат преждевременно или ЦЕЛИКОМ закрывал бы заказ и высвобождал ВЕСЬ остаток
  // (БАГ #5/#12 + регресс сетла волны 15; docs/15 §4.3: частичный — БЕЗ авто-смены
  // статуса). Событие всё равно логируется (insertStatusLog), оператор решает вручную.
  REFUNDED: 'refunded',
};

/**
 * Маппит Status Т-Банка → PaymentStatus Admik. Неизвестный/пустой код → null
 * (вызывающий пропускает переход, как mapCdekStatus). Регистр кода нормализуется
 * к верхнему (Т-Банк присылает UPPER_SNAKE, но защищаемся).
 */
export function mapTbankStatus(status: TbankStatus | null | undefined): PaymentStatus | null {
  if (!status) return null;
  return STATUS_TO_PAYMENT_STATUS[String(status).toUpperCase()] ?? null;
}
