/**
 * Репозиторий модуля payments/atol (порт lib/payments/ozon/repository.ts).
 *
 * Переиспользует статус-машину и сетл-логику платформы: applyPaymentStatusTx
 * намеренно повторяет проверенную реализацию Т-Банка и Озона, включая гарды,
 * которые уже спасали от потери денег:
 *   • АТОМАРНОСТЬ — запись журнала, применение статуса и пометка processed идут
 *     в ОДНОЙ транзакции. Раздельные транзакции приводили к тому, что при сбое
 *     посреди обработки статус не применялся, а повторная доставка вебхука
 *     видела дубликат и пропускала его — оплаченный заказ навсегда висел
 *     в pending;
 *   • ГАРД МЁРТВОГО ЗАКАЗА — переход в paid/authorized не применяется к
 *     отменённому/возвращённому заказу (гонка «админ отменил → покупатель
 *     дожал оплату»);
 *   • СЕТЛ ВОЗВРАТА — refunded освобождает резерв остатков и откатывает
 *     промокод в той же транзакции.
 *
 * 🔴 ОТЛИЧИЕ АТОЛА: запись в этот журнал — протокол «что нам прислали», а НЕ
 * основание менять статус заказа. У callback нет подписи, поэтому в журнал
 * могут попасть события, которых АТОЛ не отправлял. Решение о переходе
 * принимает сервис по ответу GET /payments/{orderId}/status, и только
 * проверенный статус приезжает сюда параметром nextStatus.
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import { canTransition } from '@/lib/orders/status';
import { settleRefundEffectsTx } from '@/lib/orders/refund-settle';
import type { OrderStatus, PaymentStatus } from '@/lib/orders/types';
import { logger } from '@/lib/logger';
import type { AtolCallbackType, AtolReceiptType } from './types';

const log = logger.child({ module: 'payments/atol' });

/** Поля события callback для журнала atol_payment_log. */
export interface AtolLogInput {
  orderId: string;
  /** orderId на стороне АТОЛа — он же ключ платежа (часть ключа идемпотентности). */
  atolOrderId: string;
  type: AtolCallbackType;
  /** Числовой статус платежа; в событии `fiscal` отсутствует. */
  paymentStatus?: number | null;
  /** Статус ОБРАБОТКИ ЗАПРОСА как прислан — для аудита, решений по нему не принимаем. */
  requestStatus?: string | null;
  /** Сумма события в КОПЕЙКАХ. */
  amountKop?: number | null;
  receiptId?: string | null;
  receiptType?: AtolReceiptType | null;
  /** 🔴 Деньги списаны, а чек не пробит — требует ручного чека коррекции. */
  receiptFailed?: boolean;
  /** У АТОЛа код ошибки ТЕКСТОВЫЙ. */
  errorCode?: string | null;
  errorMessage?: string | null;
  isMock?: boolean;
  rawPayload?: Record<string, unknown> | null;
  ip?: string | null;
}

/** Результат атомарной обработки события. */
export interface RecordCallbackResult {
  /** Событие записано впервые (false → повторная доставка того же события). */
  inserted: boolean;
  /** Переход payment_status применён в этой же транзакции. */
  processed: boolean;
}

/**
 * ТЕЛО смены payment_status на ПЕРЕДАННОЙ транзакции (без собственного begin),
 * чтобы переиспользовать внутри recordCallback в одной транзакции с записью
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
  // отменён или возвращён. Гонка: покупатель на форме оплаты → админ отменяет
  // заказ (резерв отпущен) → покупатель дожимает оплату → уведомление пометило
  // бы мёртвый заказ paid (деньги за отменённый заказ и риск оверселла).
  // Возврат (refunded) не блокируем — он легитимен после отмены.
  if (
    (to === 'paid' || to === 'authorized') &&
    (orderStatus === 'cancelled' || orderStatus === 'refunded')
  ) {
    log.warn(
      'atol: пропущен переход payment_status на отменённом/возвращённом заказе — нужна ручная сверка и возврат денег',
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
 * АТОМАРНО обрабатывает событие callback В ОДНОЙ транзакции:
 * идемпотентная запись журнала → применение перехода → пометка processed.
 *
 * Дубликат (повторная доставка того же события) → ранний выход без эффектов.
 * Если применение статуса бросит исключение, откатывается и запись журнала,
 * поэтому повторная доставка безопасно переприменит статус.
 *
 * 🔴 nextStatus обязан быть получен СВЕРКОЙ через API, а не взят из тела
 * callback: подписи у callback нет, и тело не доказывает отправителя.
 */
export async function recordCallback(input: {
  log: AtolLogInput;
  nextStatus: PaymentStatus | null;
  comment: string;
}): Promise<RecordCallbackResult> {
  return await sql.begin<RecordCallbackResult>(async (tx: TransactionSql) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO atol_payment_log (
        order_id, atol_order_id, type, payment_status, request_status,
        amount_kop, receipt_id, receipt_type, receipt_failed,
        error_code, error_message, is_mock, raw_payload, ip
      ) VALUES (
        ${input.log.orderId}, ${input.log.atolOrderId}, ${input.log.type},
        ${input.log.paymentStatus ?? null}, ${input.log.requestStatus ?? null},
        ${input.log.amountKop ?? null}, ${input.log.receiptId ?? null},
        ${input.log.receiptType ?? null}, ${input.log.receiptFailed ?? false},
        ${input.log.errorCode ?? null}, ${input.log.errorMessage ?? null},
        ${input.log.isMock ?? false},
        ${input.log.rawPayload ? sql.json(input.log.rawPayload as Record<string, never>) : null},
        ${input.log.ip ?? null}
      )
      ON CONFLICT DO NOTHING
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

    // 🔴 Непробитый чек НЕ считается обработанным фактом записи в журнал:
    // нарушение 54-ФЗ снимает только оператор чеком коррекции. Оставляем
    // processed = false, чтобы событие осталось в списке требующих разбора.
    if (!input.log.receiptFailed) {
      await tx`UPDATE atol_payment_log SET processed = true WHERE id = ${id}`;
    }
    return { inserted: true, processed };
  });
}

/**
 * Сохраняет идентификатор платежа АТОЛа (orders.payment_ref) и провайдера
 * после успешной регистрации. Идемпотентно, payment_status не меняет.
 */
export async function setPaymentRefAndProvider(
  orderId: string,
  atolOrderId: string,
): Promise<void> {
  await sql`
    UPDATE orders
       SET payment_ref = ${atolOrderId},
           payment_provider = 'atol',
           updated_at = now()
     WHERE id = ${orderId}
  `;
}

/** Находит заказ по идентификатору платежа АТОЛа (payment_ref). */
export async function findOrderIdByPaymentRef(atolOrderId: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM orders
     WHERE payment_ref = ${atolOrderId} AND payment_provider = 'atol'
     LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/** Заказы с незавершённой оплатой АТОЛа — для крон-сверки зависших платежей. */
export interface PendingAtolOrder {
  orderId: string;
  orderNumber: string;
  atolOrderId: string;
  paymentStatus: PaymentStatus;
  grandTotal: string;
}

/**
 * Ищет заказы, где оплата начата, но не завершена. Нужно для сверки: если
 * callback потерялся, статус иначе останется pending навсегда. У АТОЛа сверка
 * особенно важна — callback не подписан и не является основанием сам по себе.
 */
export async function findPendingAtolPayments(limit = 50): Promise<PendingAtolOrder[]> {
  const rows = await sql<
    {
      id: string;
      number: string;
      payment_ref: string;
      payment_status: string;
      grand_total: string;
    }[]
  >`
    SELECT id, number, payment_ref, payment_status, grand_total
      FROM orders
     WHERE payment_provider = 'atol'
       AND payment_ref IS NOT NULL
       AND payment_status IN ('pending', 'authorized')
       AND created_at > now() - interval '7 days'
     -- 🔴 СТАРЫЕ ПЕРВЫМИ (как в Т-Банке), а не новые. При заторе больше LIMIT
     -- зависших заказов сортировка по убыванию означала бы, что до самых старых
     -- очередь не дойдёт НИКОГДА: каждый прогон брал бы свежую полусотню.
     -- Для АТОЛа это особенно опасно — здесь сверка не страховка, а основной
     -- путь подтверждения оплаты (callback не подписан), и застрявший заказ
     -- остался бы неоплаченным при списанных деньгах.
     ORDER BY created_at
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    orderId: r.id,
    orderNumber: r.number,
    atolOrderId: r.payment_ref,
    paymentStatus: r.payment_status as PaymentStatus,
    grandTotal: r.grand_total,
  }));
}

/** Непробитые чеки, требующие ручного разбора (54-ФЗ). */
export interface FailedReceipt {
  orderId: string;
  orderNumber: string;
  atolOrderId: string;
  receiptId: string | null;
  errorMessage: string | null;
  receivedAt: Date;
}

/**
 * 🔴 События «деньги списаны, чек не пробит». Документация АТОЛа: «транзакция
 * не отменяется, если чек отправился неуспешно». Такое обязано попадать
 * оператору на глаза, а не лежать в журнале незамеченным.
 */
export async function findFailedReceipts(limit = 50): Promise<FailedReceipt[]> {
  const rows = await sql<
    {
      order_id: string;
      number: string;
      atol_order_id: string;
      receipt_id: string | null;
      error_message: string | null;
      received_at: Date;
    }[]
  >`
    SELECT l.order_id, o.number, l.atol_order_id, l.receipt_id,
           l.error_message, l.received_at
      FROM atol_payment_log l
      JOIN orders o ON o.id = l.order_id
     WHERE l.receipt_failed
     ORDER BY l.received_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    orderId: r.order_id,
    orderNumber: r.number,
    atolOrderId: r.atol_order_id,
    receiptId: r.receipt_id,
    errorMessage: r.error_message,
    receivedAt: r.received_at,
  }));
}
