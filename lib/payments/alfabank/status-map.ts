/**
 * Маппинг статуса Альфа-Банка → orders.payment_status Admik (порт tbank/status-map.ts
 * + paykeeper/status-map.ts). ЧИСТАЯ, без сети/БД — всегда зелёная.
 *
 * Существующий PaymentStatus (pending|authorized|paid|failed|refunded) покрывает все
 * исходы Альфа-Банка — новых значений в БД НЕ требуется. У RBS есть двухстадийная
 * оплата (hold) → 'authorized' используется (orderStatus=1).
 *
 * Два источника статуса:
 *   1) getOrderStatusExtended.do → числовой orderStatus (reconcile) — mapOrderStatus;
 *   2) callbackUrl → operation + status ('1'/'0') — mapCallbackOperation.
 *
 * | orderStatus (число) | смысл RBS                              | payment_status |
 * |---------------------|---------------------------------------|----------------|
 * | 0                   | зарегистрирован, не оплачен           | pending        |
 * | 1                   | предавторизация удержана (hold)       | authorized     |
 * | 2                   | полная авторизация (оплачен)          | paid           |
 * | 3                   | авторизация отменена (reversed)       | failed         |
 * | 4                   | возврат выполнен                      | refunded       |
 * | 5                   | 3-D Secure (ACS эмитента)             | pending        |
 * | 6                   | авторизация отклонена (declined)      | failed         |
 */

import type { PaymentStatus } from '@/lib/orders/types';
import type { AlfabankOperation, AlfabankOrderStatus } from './types';

/** Таблица соответствия числового orderStatus RBS → payment_status Admik. */
export const ORDER_STATUS_TO_PAYMENT_STATUS: Readonly<Record<number, PaymentStatus>> = {
  0: 'pending', // зарегистрирован, не оплачен
  1: 'authorized', // предавторизация удержана (hold, двухстадийная)
  2: 'paid', // полная авторизация — оплачен
  3: 'failed', // авторизация отменена (reversed)
  4: 'refunded', // возврат выполнен
  5: 'pending', // 3-D Secure в процессе
  6: 'failed', // авторизация отклонена
};

/**
 * Маппит числовой orderStatus Альфа-Банка → PaymentStatus Admik. Неизвестный/пустой →
 * null (вызывающий пропускает переход, как mapTbankStatus/mapPaykeeperStatus).
 */
export function mapOrderStatus(
  status: AlfabankOrderStatus | null | undefined,
): PaymentStatus | null {
  if (status === null || status === undefined) return null;
  const n = Number(status);
  if (!Number.isInteger(n)) return null;
  return ORDER_STATUS_TO_PAYMENT_STATUS[n] ?? null;
}

/**
 * Маппит операцию колбэка Альфа-Банка (operation + status) → PaymentStatus Admik.
 * Колбэк несёт факт операции по заказу и её итог (status '1' успех / '0' неуспех):
 *   • неуспех (status != '1') → null (переход не применяется — событие лишь логируется);
 *   • deposited (успех)            → paid;
 *   • approved  (успех, hold)      → authorized;
 *   • reversed  (успех)            → failed (холд снят / оплата отменена);
 *   • refunded  (успех)            → refunded;
 *   • declinedByTimeout / иное      → null.
 * Регистр operation нормализуется (RBS присылает camelCase, защищаемся lowercase).
 */
export function mapCallbackOperation(
  operation: AlfabankOperation | null | undefined,
  status: string | null | undefined,
): PaymentStatus | null {
  // Неуспешная операция (status != '1') не двигает payment_status.
  if (status !== '1') return null;
  if (!operation) return null;
  switch (String(operation).toLowerCase()) {
    case 'deposited':
      return 'paid';
    case 'approved':
      return 'authorized';
    case 'reversed':
      return 'failed';
    case 'refunded':
      return 'refunded';
    default:
      return null;
  }
}
