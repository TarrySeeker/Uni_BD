/**
 * Репозиторий модуля payments/ozon (порт lib/payments/tbank/repository.ts).
 *
 * Переиспользует статус-машину и сетл-логику платформы: applyPaymentStatusTx
 * здесь намеренно повторяет проверенную реализацию Т-Банка, включая гарды,
 * которые уже спасали от потери денег:
 *   • АТОМАРНОСТЬ — запись лога, применение статуса и пометка processed идут в
 *     ОДНОЙ транзакции. Раздельные транзакции приводили к тому, что при сбое
 *     посреди обработки статус не применялся, а повторная доставка вебхука
 *     видела дубликат и пропускала его — оплаченный заказ навсегда висел
 *     в pending;
 *   • ГАРД МЁРТВОГО ЗАКАЗА — переход в paid/authorized не применяется к
 *     отменённому/возвращённому заказу (гонка «админ отменил → покупатель
 *     дожал оплату»);
 *   • СЕТЛ ВОЗВРАТА — refunded освобождает резерв остатков и откатывает
 *     промокод в той же транзакции.
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import { canTransition } from '@/lib/orders/status';
import { settleRefundEffectsTx } from '@/lib/orders/refund-settle';
import type { OrderStatus, PaymentStatus } from '@/lib/orders/types';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'payments/ozon' });

/** Поля события уведомления Ozon для журнала ozon_payment_log. */
export interface OzonLogInput {
  orderId: string;
  /** UUID попытки оплаты — ключ идемпотентности вместе со status. */
  transactionUid: string;
  status: string;
  ozonOrderId?: string | null;
  paymentMethod?: string | null;
  /** Сумма события в КОПЕЙКАХ (как приходит от Ozon). */
  amountKop?: number | null;
  errorCode?: number | null;
  errorMessage?: string | null;
  isTest?: boolean;
  isMock?: boolean;
  rawPayload?: Record<string, unknown> | null;
  ip?: string | null;
}

/** Результат атомарной обработки уведомления. */
export interface RecordNotificationResult {
  /** Событие записано впервые (false → повторная доставка того же события). */
  inserted: boolean;
  /** Переход payment_status применён в этой же транзакции. */
  processed: boolean;
}

/**
 * ТЕЛО смены payment_status на ПЕРЕДАННОЙ транзакции (без собственного begin),
 * чтобы переиспользовать внутри recordNotification в одной транзакции с записью
 * журнала. Возвращает true, если переход применён.
 */
async function applyPaymentStatusTx(
  tx: TransactionSql,
  orderId: string,
  to: PaymentStatus,
  comment: string,
): Promise<boolean> {
  const rows = await tx<{ payment_status: string; status: string }[]>`
    SELECT payment_status, status FROM orders WHERE id = ${orderId} FOR UPDATE
  `;
  const from = rows[0]?.payment_status as PaymentStatus | undefined;
  const orderStatus = rows[0]?.status as OrderStatus | undefined;
  if (!from) return false;
  if (from === to) return false;
  if (!canTransition('payment', from, to)) return false;

  // ГАРД МЁРТВОГО ЗАКАЗА (ДЕНЬГИ): не помечаем оплаченным заказ, который уже
  // отменён или возвращён. Гонка: покупатель на форме банка → админ отменяет
  // заказ (резерв отпущен) → покупатель дожимает оплату → подписанное
  // уведомление пометило бы мёртвый заказ paid (деньги за отменённый заказ
  // и риск оверселла). Возврат (refunded) не блокируем — легитимен после отмены.
  if (
    (to === 'paid' || to === 'authorized') &&
    (orderStatus === 'cancelled' || orderStatus === 'refunded')
  ) {
    log.warn(
      'ozon: пропущен переход payment_status на отменённом/возвращённом заказе — нужна ручная сверка и возврат денег',
      { orderId, orderStatus, from, to },
    );
    return false;
  }

  const updated =
    to === 'paid'
      ? await tx`
          UPDATE orders
             SET payment_status = ${to}, paid_at = now(), updated_at = now()
           WHERE id = ${orderId} AND payment_status = ${from}
        `
      : await tx`
          UPDATE orders
             SET payment_status = ${to}, updated_at = now()
           WHERE id = ${orderId} AND payment_status = ${from}
        `;

  // Страховка от гонки: статус изменился между SELECT и UPDATE.
  if (updated.count !== 1) return false;

  await tx`
    INSERT INTO order_status_history
      (order_id, kind, from_status, to_status, actor_user_id, comment)
    VALUES
      (${orderId}, 'payment', ${from}, ${to}, NULL, ${comment})
  `;

  // Возврат обязан выполнить складско-промо-сетл В ТОЙ ЖЕ транзакции — иначе
  // резерв остатков остаётся заблокированным навсегда, промокод не откатан.
  if (to === 'refunded') {
    await settleRefundEffectsTx(tx, orderId, null);
  }
  return true;
}

/**
 * Применяет переход payment_status. Идемпотентно: повторный вызов с тем же
 * целевым статусом — no-op (false).
 */
export async function applyPaymentStatus(
  orderId: string,
  to: PaymentStatus,
  comment = '',
): Promise<boolean> {
  return await sql.begin<boolean>((tx: TransactionSql) =>
    applyPaymentStatusTx(tx, orderId, to, comment),
  );
}

/**
 * АТОМАРНО обрабатывает уведомление Ozon В ОДНОЙ транзакции:
 * идемпотентная запись журнала → применение перехода → пометка processed.
 *
 * Дубликат (повторная доставка того же события) → ранний выход без эффектов.
 * Если применение статуса бросит исключение, откатывается и запись журнала,
 * поэтому повторная доставка безопасно переприменит статус.
 */
export async function recordNotification(input: {
  log: OzonLogInput;
  nextStatus: PaymentStatus | null;
  comment: string;
}): Promise<RecordNotificationResult> {
  return await sql.begin<RecordNotificationResult>(async (tx: TransactionSql) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO ozon_payment_log (
        order_id, ozon_order_id, transaction_uid, status, payment_method,
        amount_kop, error_code, error_message, is_test, is_mock, raw_payload, ip
      ) VALUES (
        ${input.log.orderId}, ${input.log.ozonOrderId ?? null},
        ${input.log.transactionUid}, ${input.log.status},
        ${input.log.paymentMethod ?? null}, ${input.log.amountKop ?? null},
        ${input.log.errorCode ?? null}, ${input.log.errorMessage ?? null},
        ${input.log.isTest ?? false}, ${input.log.isMock ?? false},
        ${input.log.rawPayload ? sql.json(input.log.rawPayload as Record<string, never>) : null},
        ${input.log.ip ?? null}
      )
      ON CONFLICT (transaction_uid, status) DO NOTHING
      RETURNING id
    `;
    const id = rows[0]?.id ?? null;
    if (id === null) return { inserted: false, processed: false };

    let processed = false;
    if (input.nextStatus) {
      processed = await applyPaymentStatusTx(
        tx,
        input.log.orderId,
        input.nextStatus,
        input.comment,
      );
    }

    await tx`UPDATE ozon_payment_log SET processed = true WHERE id = ${id}`;
    return { inserted: true, processed };
  });
}

/**
 * Сохраняет идентификатор заказа Ozon (orders.payment_ref) и провайдера
 * после успешного createOrder. Идемпотентно, payment_status не меняет.
 */
export async function setPaymentRefAndProvider(
  orderId: string,
  ozonOrderId: string,
): Promise<void> {
  await sql`
    UPDATE orders
       SET payment_ref = ${ozonOrderId},
           payment_provider = 'ozon',
           updated_at = now()
     WHERE id = ${orderId}
  `;
}

/**
 * Находит заказ по идентификатору заказа Ozon (payment_ref) — на случай, когда
 * уведомление пришло без нашего extOrderID.
 */
export async function findOrderIdByPaymentRef(ozonOrderId: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM orders
     WHERE payment_ref = ${ozonOrderId} AND payment_provider = 'ozon'
     LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/** Заказы с незавершённой оплатой Ozon — для крон-сверки зависших платежей. */
export interface PendingOzonOrder {
  orderId: string;
  orderNumber: string;
  ozonOrderId: string;
  paymentStatus: PaymentStatus;
}

/**
 * Ищет заказы, где оплата Ozon начата, но не завершена. Нужно для сверки:
 * если уведомление потерялось, статус иначе останется pending навсегда.
 * Окно ограничено, чтобы не тянуть всю историю.
 */
export async function findPendingOzonPayments(limit = 50): Promise<PendingOzonOrder[]> {
  const rows = await sql<
    { id: string; number: string; payment_ref: string; payment_status: string }[]
  >`
    SELECT id, number, payment_ref, payment_status
      FROM orders
     WHERE payment_provider = 'ozon'
       AND payment_ref IS NOT NULL
       AND payment_status IN ('pending', 'authorized')
       AND created_at > now() - interval '7 days'
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    orderId: r.id,
    orderNumber: r.number,
    ozonOrderId: r.payment_ref,
    paymentStatus: r.payment_status as PaymentStatus,
  }));
}
