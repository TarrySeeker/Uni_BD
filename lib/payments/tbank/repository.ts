/**
 * Репозиторий модуля payments/tbank (docs/15 §4.2, §4.4, порт lib/cdek/repository
 * + delivery-status). БД-зависимый слой:
 *   • recordWebhookEvent — АТОМАРНАЯ обработка события webhook в ОДНОЙ транзакции
 *     (запись лога + применение статуса + пометка processed); закрывает critical-баг
 *     неатомарности (потеря денег при сбое посреди трёх отдельных транзакций);
 *   • insertPaymentLog — идемпотентная запись события webhook (ON CONFLICT DO
 *     NOTHING по UNIQUE (payment_id, status)); дубликат → inserted=false; оставлена
 *     как самостоятельный примитив (не используется handleWebhook после фикса);
 *   • markPaymentLogProcessed — пометить событие обработанным (самостоятельный примитив);
 *   • applyPaymentStatus — смена orders.payment_status через статус-машину
 *     canTransition('payment', …) в транзакции (UPDATE orders + INSERT history),
 *     БЕЗ Server Actions (webhook не имеет RBAC-контекста), как applyDeliveryStatus;
 *   • setPaymentRefAndProvider — сохранить PaymentId/провайдера на заказе после Init.
 *
 * Идемпотентность/безопасность: переход применяется лишь если допустим (from→to);
 * from===to / недопустимый / заказ не найден → no-op (false). Повторный вызов
 * безопасен. paid проставляет paid_at (§2.8 B), как setPaymentStatus в actions.
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import { canTransition } from '@/lib/orders/status';
import { settleRefundEffectsTx } from '@/lib/orders/refund-settle';
import type { OrderStatus, PaymentStatus } from '@/lib/orders/types';
import { logger } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Лог webhook (идемпотентность).
// -----------------------------------------------------------------------------

/** Поля для записи события в tbank_payment_log (идемпотентная вставка). */
export interface PaymentLogInput {
  orderId: string;
  paymentId: string;
  status: string;
  amountKop?: number | null;
  isMock?: boolean;
  rawPayload?: Record<string, unknown> | null;
  ip?: string | null;
}

/** Результат идемпотентной вставки: inserted=true → новое событие; false → дубликат. */
export interface PaymentLogResult {
  inserted: boolean;
  id: string | null;
}

/**
 * Идемпотентно пишет событие webhook (docs/15 §4.2). UNIQUE (payment_id, status);
 * дубликат (повторная доставка) → inserted=false (переход не повторяем).
 */
export async function insertPaymentLog(input: PaymentLogInput): Promise<PaymentLogResult> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tbank_payment_log (
      order_id, payment_id, status, amount_kop, is_mock, raw_payload, ip
    ) VALUES (
      ${input.orderId}, ${input.paymentId}, ${input.status},
      ${input.amountKop ?? null}, ${input.isMock ?? false},
      ${input.rawPayload ? sql.json(input.rawPayload as Record<string, never>) : null},
      ${input.ip ?? null}
    )
    ON CONFLICT (payment_id, status) DO NOTHING
    RETURNING id
  `;
  const id = rows[0]?.id ?? null;
  return { inserted: id !== null, id };
}

/** Помечает запись лога обработанной (переход payment_status применён). */
export async function markPaymentLogProcessed(id: string): Promise<void> {
  await sql`UPDATE tbank_payment_log SET processed = true WHERE id = ${id}`;
}

// -----------------------------------------------------------------------------
// Смена payment_status (без Server Actions) — порт applyDeliveryStatus.
// -----------------------------------------------------------------------------

/**
 * ТЕЛО смены payment_status на ПЕРЕДАННОЙ транзакции `tx` (без собственного begin).
 * Вынесено из applyPaymentStatus, чтобы переиспользовать ту же логику внутри
 * recordWebhookEvent в ОДНОЙ транзакции с записью лога webhook (атомарность,
 * см. doc-комментарий recordWebhookEvent). Внутренняя — НЕ экспортируется.
 *
 * Возвращает true, если переход применён; false — пропущен (недопустим / заказ не
 * найден / from===to / проиграна гонка guarded UPDATE). Идемпотентно при повторе.
 * paid проставляет paid_at (§2.8 B). SELECT ... FOR UPDATE + guarded UPDATE
 * (WHERE payment_status = from) + INSERT history (actor_user_id=NULL → система).
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

  // C4-1 (аудит цикла 4, ДЕНЬГИ): гард мёртвого заказа на сетл-пути. Переход в
  // «деньги получены» (paid/authorized) НЕ применяется к ОТМЕНЁННОМУ/ВОЗВРАЩЁННОМУ
  // заказу. Гонка: клиент на шлюзе → админ отменяет заказ (резерв отпущен, payment
  // остаётся pending/authorized) → клиент дожимает оплату → подписанный CONFIRMED-
  // webhook метил бы мёртвый заказ paid (деньги за отменённый заказ + риск оверселла).
  // Зеркалит isOrderPayable (lib/orders/status) — прежде гард был ТОЛЬКО в initPayment,
  // не на сетле. Возврат (refunded) НЕ блокируем — это легитимный пост-отменный переход.
  // Webhook всё равно отвечает OK идемпотентно; warn — для ручной сверки (оператор
  // инициирует возврат поступивших денег).
  if (
    (to === 'paid' || to === 'authorized') &&
    (orderStatus === 'cancelled' || orderStatus === 'refunded')
  ) {
    logger.warn(
      'tbank: пропущен переход payment_status на отменённом/возвращённом заказе — требуется ручная сверка/возврат',
      { module: 'payments/tbank', orderId, orderStatus, from, to },
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

  // Гонка: статус успел измениться между SELECT и UPDATE (теоретически невозможно
  // под FOR UPDATE в одной транзакции, но guarded UPDATE — дешёвая страховка
  // на случай иной изоляции/реплик). 0 строк → эффект не применяем.
  if (updated.count !== 1) return false;

  await tx`
    INSERT INTO order_status_history
      (order_id, kind, from_status, to_status, actor_user_id, comment)
    VALUES
      (${orderId}, 'payment', ${from}, ${to}, NULL, ${comment})
  `;

  // БАГ #4 (аудит волны 15): возврат денег (webhook Т-Банка REFUNDED) обязан
  // выполнить складско-промо-сетл В ТОЙ ЖЕ транзакции — иначе резерв остатков
  // навсегда заблокирован, промокод не откатан, заказ остаётся 'paid'. Идемпотентно.
  if (to === 'refunded') {
    await settleRefundEffectsTx(tx, orderId, null);
  }
  return true;
}

/**
 * Применяет переход payment_status заказа, если он допустим статус-машиной
 * canTransition('payment', …). Возвращает true, если применён; false — пропущен
 * (недопустим / заказ не найден / from===to). Идемпотентно при повторном вызове.
 * paid проставляет paid_at (§2.8 B). Транзакция: UPDATE orders + INSERT history
 * (kind='payment', actor_user_id=NULL → система/Т-Банк).
 *
 * АТОМАРНОСТЬ (анти-TOCTOU): чтение `from`, проверка перехода и запись — в ОДНОЙ
 * транзакции (sql.begin), тело делегировано applyPaymentStatusTx. SELECT ... FOR
 * UPDATE берёт блокировку строки заказа на время транзакции, так что конкурентный
 * webhook ждёт коммита и видит уже актуальный статус.
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

/** Результат атомарной обработки события webhook (recordWebhookEvent). */
export interface RecordWebhookResult {
  /** Событие записано впервые (false → дубликат: ON CONFLICT DO NOTHING). */
  inserted: boolean;
  /** Переход payment_status применён в этой же транзакции. */
  processed: boolean;
}

/**
 * АТОМАРНО обрабатывает событие webhook Т-Банка В ОДНОЙ транзакции (sql.begin):
 * идемпотентная запись лога → применение перехода payment_status → пометка лога
 * processed. Закрывает critical-баг неатомарности (потеря денег).
 *
 * БАГ (до фикса): handleWebhook делал три шага в ТРЁХ разных транзакциях
 * (insertPaymentLog авто-коммит → applyPaymentStatus собственный begin →
 * markPaymentLogProcessed авто-коммит). Если applyPaymentStatus БРОСАЛ исключение
 * (транзиентный сбой БД: deadlock / lock_timeout / обрыв соединения) ПОСЛЕ коммита
 * лога, то статус НЕ применялся, строка лога оставалась processed=false навсегда,
 * а повторная доставка webhook видела inserted=false (дубликат) и НЕ применяла
 * статус → оплаченный заказ навсегда висел в pending. Деньги терялись.
 *
 * ФИКС: всё в ОДНОЙ транзакции. Если applyPaymentStatusTx бросит — вся транзакция
 * (включая INSERT лога) откатывается, поэтому повтор события снова даст
 * inserted=true и переприменит статус. Дубликат (inserted=false) → ранний выход
 * без эффектов (повторно применять статус не нужно).
 *
 * Колонки лога идентичны insertPaymentLog (order_id, payment_id, status, amount_kop,
 * is_mock, raw_payload, ip), UNIQUE (payment_id, status) → ON CONFLICT DO NOTHING.
 */
export async function recordWebhookEvent(input: {
  log: PaymentLogInput;
  nextStatus: PaymentStatus | null;
  comment: string;
}): Promise<RecordWebhookResult> {
  return await sql.begin<RecordWebhookResult>(async (tx: TransactionSql) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO tbank_payment_log (
        order_id, payment_id, status, amount_kop, is_mock, raw_payload, ip
      ) VALUES (
        ${input.log.orderId}, ${input.log.paymentId}, ${input.log.status},
        ${input.log.amountKop ?? null}, ${input.log.isMock ?? false},
        ${input.log.rawPayload ? sql.json(input.log.rawPayload as Record<string, never>) : null},
        ${input.log.ip ?? null}
      )
      ON CONFLICT (payment_id, status) DO NOTHING
      RETURNING id
    `;
    const id = rows[0]?.id ?? null;
    // Дубликат (повторная доставка) — эффект уже применён ранее, не повторяем.
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

    await tx`UPDATE tbank_payment_log SET processed = true WHERE id = ${id}`;
    return { inserted: true, processed };
  });
}

/**
 * Сохраняет PaymentId Т-Банка (orders.payment_ref) и провайдера
 * (orders.payment_provider='tbank') после успешного Init. Идемпотентно
 * (перезапись теми же значениями безопасна). Не меняет payment_status.
 */
export async function setPaymentRefAndProvider(
  orderId: string,
  paymentId: string,
): Promise<void> {
  await sql`
    UPDATE orders
       SET payment_ref = ${paymentId},
           payment_provider = 'tbank',
           updated_at = now()
     WHERE id = ${orderId}
  `;
}
