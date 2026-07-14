/**
 * Маппинг статуса PayKeeper → orders.payment_status Admik (docs/24 §2, порт
 * tbank/status-map.ts). ЧИСТАЯ, без сети/БД — всегда зелёная.
 *
 * Существующий PaymentStatus (pending|authorized|paid|failed|refunded) покрывает
 * все исходы PayKeeper — новых значений в БД НЕ требуется (docs/24 §2). У PayKeeper
 * нет стадии hold → 'authorized' не используется.
 *
 * | Статус PayKeeper (регистронезависимо)     | payment_status |
 * |-------------------------------------------|----------------|
 * | new, waiting, pending, sent               | pending        |
 * | paid, PAID (синтетический на колбэке)      | paid           |
 * | expired, cancelled/canceled, fail/failed, | failed         |
 * |   error                                   |                |
 * | refunded, reversed, returned              | refunded       |
 */

import type { PaymentStatus } from '@/lib/orders/types';
import type { PaykeeperStatus } from './types';

/** Полная таблица соответствия статуса PayKeeper (lowercase) → payment_status. */
export const STATUS_TO_PAYMENT_STATUS: Readonly<Record<string, PaymentStatus>> = {
  // Счёт выставлен / ожидает / отправлен — ещё ждём (pending).
  new: 'pending',
  waiting: 'pending',
  pending: 'pending',
  sent: 'pending',

  // Оплачено. Синтетический 'PAID' (колбэк) нормализуется к lowercase → paid.
  paid: 'paid',

  // Истёк / отменён / ошибка — провал.
  expired: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  fail: 'failed',
  failed: 'failed',
  error: 'failed',

  // Возврат (терминальный сетл: освобождение резерва + откат промокода +
  // order.status='refunded', см. settleRefundEffectsTx).
  refunded: 'refunded',
  reversed: 'refunded',
  returned: 'refunded',
};

/**
 * Маппит статус PayKeeper → PaymentStatus Admik. Неизвестный/пустой → null
 * (вызывающий пропускает переход). Регистр нормализуется к нижнему (PayKeeper
 * присылает разный регистр; синтетический 'PAID' → 'paid').
 */
export function mapPaykeeperStatus(
  status: PaykeeperStatus | null | undefined,
): PaymentStatus | null {
  if (!status) return null;
  return STATUS_TO_PAYMENT_STATUS[String(status).toLowerCase()] ?? null;
}
