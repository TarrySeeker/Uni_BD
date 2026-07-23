/**
 * Репозиторий модуля payments/paykeeper (docs/24 §2, порт tbank/repository.ts на
 * таблицу paykeeper_payment_log с ключом идемпотентности UNIQUE (invoice_id, status)).
 * БД-зависимый слой:
 *   • recordWebhookEvent — АТОМАРНАЯ обработка колбэка в ОДНОЙ транзакции (запись
 *     лога + применение статуса + пометка processed); закрывает баг неатомарности
 *     (потеря денег при сбое посреди отдельных транзакций);
 *   • insertPaymentLog — идемпотентная запись события (ON CONFLICT DO NOTHING по
 *     UNIQUE (invoice_id, status));
 *   • markPaymentLogProcessed — пометить событие обработанным;
 *   • applyPaymentStatus — смена orders.payment_status через canTransition('payment', …)
 *     в транзакции (UPDATE orders + INSERT history), БЕЗ Server Actions (колбэк без RBAC);
 *   • setPaymentRefAndProvider — сохранить invoice_id/провайдера на заказе после init.
 *
 * Идемпотентность/безопасность: переход применяется лишь если допустим (from→to);
 * from===to / недопустимый / заказ не найден → no-op (false). paid проставляет
 * paid_at. Гард C4-1 (деньги) не даёт пометить paid отменённый/возвращённый заказ.
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import { canTransition } from '@/lib/orders/status';
import { settleRefundEffectsTx } from '@/lib/orders/refund-settle';
import type { OrderStatus, PaymentStatus } from '@/lib/orders/types';
import { logger } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Лог колбэка (идемпотентность).
// -----------------------------------------------------------------------------

/** Поля для записи события в paykeeper_payment_log (идемпотентная вставка). */
export interface PaymentLogInput {
  orderId: string;
  invoiceId: string;
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
 * Идемпотентно пишет событие колбэка (docs/24 §2). UNIQUE (invoice_id, status);
 * дубликат (повторная доставка — PayKeeper ретраит до 50 раз) → inserted=false.
 */
export async function insertPaymentLog(input: PaymentLogInput): Promise<PaymentLogResult> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO paykeeper_payment_log (
      order_id, invoice_id, status, amount_kop, is_mock, raw_payload, ip
    ) VALUES (
      ${input.orderId}, ${input.invoiceId}, ${input.status},
      ${input.amountKop ?? null}, ${input.isMock ?? false},
      ${input.rawPayload ? sql.json(input.rawPayload as Record<string, never>) : null},
      ${input.ip ?? null}
    )
    ON CONFLICT (invoice_id, status) DO NOTHING
    RETURNING id
  `;
  const id = rows[0]?.id ?? null;
  return { inserted: id !== null, id };
}

/** Помечает запись лога обработанной (переход payment_status применён). */
export async function markPaymentLogProcessed(id: string): Promise<void> {
  await sql`UPDATE paykeeper_payment_log SET processed = true WHERE id = ${id}`;
}

// -----------------------------------------------------------------------------
// Смена payment_status (без Server Actions) — порт tbank applyPaymentStatusTx.
// -----------------------------------------------------------------------------

/**
 * ТЕЛО смены payment_status на ПЕРЕДАННОЙ транзакции `tx` (без собственного begin).
 * Вынесено, чтобы переиспользовать внутри recordWebhookEvent в ОДНОЙ транзакции с
 * записью лога (атомарность). Внутренняя — НЕ экспортируется.
 *
 * Возвращает true, если переход применён; false — пропущен (недопустим / заказ не
 * найден / from===to / проиграна гонка guarded UPDATE). Идемпотентно при повторе.
 * paid проставляет paid_at. SELECT ... FOR UPDATE + guarded UPDATE + INSERT history
 * (actor_user_id=NULL → система).
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

  // C4-1 (ДЕНЬГИ): переход в «деньги получены» (paid/authorized) НЕ применяется к
  // ОТМЕНЁННОМУ/ВОЗВРАЩЁННОМУ заказу (зеркалит isOrderPayable). Колбэк всё равно
  // отвечает OK идемпотентно; warn — для ручной сверки/возврата. Возврат (refunded)
  // НЕ блокируем — легитимный пост-отменный переход.
  if (
    (to === 'paid' || to === 'authorized') &&
    (orderStatus === 'cancelled' || orderStatus === 'refunded')
  ) {
    logger.warn(
      'paykeeper: пропущен переход payment_status на отменённом/возвращённом заказе — требуется ручная сверка/возврат',
      { module: 'payments/paykeeper', orderId, orderStatus, from, to },
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

  // Гонка: статус изменился между SELECT и UPDATE (под FOR UPDATE невозможно, но
  // guarded UPDATE — дешёвая страховка). 0 строк → эффект не применяем.
  if (updated.count !== 1) return false;

  await tx`
    INSERT INTO order_status_history
      (order_id, kind, from_status, to_status, actor_user_id, comment)
    VALUES
      (${orderId}, 'payment', ${from}, ${to}, NULL, ${comment})
  `;

  // Возврат (колбэк/сверка refunded) обязан выполнить складско-промо-сетл В ТОЙ ЖЕ
  // транзакции — иначе резерв заблокирован, промокод не откатан. Идемпотентно.
  if (to === 'refunded') {
    await settleRefundEffectsTx(tx, orderId, null);
  }
  return true;
}

/**
 * Применяет переход payment_status заказа, если допустим canTransition('payment', …).
 * Возвращает true, если применён; false — пропущен. Идемпотентно. Транзакция:
 * SELECT ... FOR UPDATE + guarded UPDATE + INSERT history, тело — applyPaymentStatusTx.
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

/** Результат атомарной обработки события колбэка (recordWebhookEvent). */
export interface RecordWebhookResult {
  /** Событие записано впервые (false → дубликат: ON CONFLICT DO NOTHING). */
  inserted: boolean;
  /** Переход payment_status применён в этой же транзакции. */
  processed: boolean;
  /**
   * Синоним processed под именем вызывающей стороны: «переход реально применён
   * ЭТИМ событием». Вынесен наружу вместе с paymentStatus, чтобы пост-коммитные
   * эффекты (автовыпуск подарочных сертификатов, ТЗ п.11) могли отличить
   * «заказ стал paid прямо сейчас» от «событие записано, перехода не было».
   */
  applied: boolean;
  /** Статус, в который заказ переведён этим событием; null — перехода не было. */
  paymentStatus: PaymentStatus | null;
}

/**
 * АТОМАРНО обрабатывает событие колбэка PayKeeper В ОДНОЙ транзакции (sql.begin):
 * идемпотентная запись лога → применение перехода payment_status → пометка лога
 * processed. Закрывает баг неатомарности (потеря денег): при сбое посреди обработки
 * откатывается ВСЁ (включая вставку лога) → повтор колбэка снова применит статус.
 * Дубликат (inserted=false) → ранний выход без эффектов.
 *
 * Ключ идемпотентности — UNIQUE (invoice_id, status) → ON CONFLICT DO NOTHING.
 */
export async function recordWebhookEvent(input: {
  log: PaymentLogInput;
  nextStatus: PaymentStatus | null;
  comment: string;
}): Promise<RecordWebhookResult> {
  return await sql.begin<RecordWebhookResult>(async (tx: TransactionSql) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO paykeeper_payment_log (
        order_id, invoice_id, status, amount_kop, is_mock, raw_payload, ip
      ) VALUES (
        ${input.log.orderId}, ${input.log.invoiceId}, ${input.log.status},
        ${input.log.amountKop ?? null}, ${input.log.isMock ?? false},
        ${input.log.rawPayload ? sql.json(input.log.rawPayload as Record<string, never>) : null},
        ${input.log.ip ?? null}
      )
      ON CONFLICT (invoice_id, status) DO NOTHING
      RETURNING id
    `;
    const id = rows[0]?.id ?? null;
    // Дубликат (повторная доставка) — эффект уже применён, не повторяем.
    if (id === null)
      return { inserted: false, processed: false, applied: false, paymentStatus: null };

    let processed = false;
    if (input.nextStatus) {
      processed = await applyPaymentStatusTx(
        tx,
        input.log.orderId,
        input.nextStatus,
        input.comment,
      );
    }

    await tx`UPDATE paykeeper_payment_log SET processed = true WHERE id = ${id}`;
    return {
      inserted: true,
      processed,
      applied: processed,
      paymentStatus: processed ? input.nextStatus : null,
    };
  });
}

/**
 * Ищет id заказа по invoice_id (orders.payment_ref). Приоритетный способ поиска
 * заказа на колбэке (docs/24 §2): payment_ref пишется при создании счёта. Возвращает
 * null, если заказ с таким payment_ref не найден (вызывающий пробует фолбэк по номеру).
 */
export async function findOrderIdByInvoiceId(invoiceId: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM orders WHERE payment_ref = ${invoiceId} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Возвращает СЕРВЕРНЫЙ grand_total заказа (рублёвая строка) для сверки суммы колбэка
 * (anti-tamper, docs/24 §2). Источник истины — БД, НЕ поле `sum` из тела колбэка.
 * null → заказ не найден. Вынесено отдельно (лёгкий SELECT без join позиций), чтобы
 * handleCallback сверял сумму, не поднимая полный OrderWithItems.
 */
export async function getOrderGrandTotalById(orderId: string): Promise<string | null> {
  const rows = await sql<{ grand_total: string }[]>`
    SELECT grand_total FROM orders WHERE id = ${orderId} LIMIT 1
  `;
  return rows[0]?.grand_total ?? null;
}

/**
 * Сохраняет invoice_id PayKeeper (orders.payment_ref) и провайдера
 * (orders.payment_provider='paykeeper') после успешного создания счёта.
 * Идемпотентно. Не меняет payment_status.
 */
export async function setPaymentRefAndProvider(
  orderId: string,
  invoiceId: string,
): Promise<void> {
  await sql`
    UPDATE orders
       SET payment_ref = ${invoiceId},
           payment_provider = 'paykeeper',
           updated_at = now()
     WHERE id = ${orderId}
  `;
}
