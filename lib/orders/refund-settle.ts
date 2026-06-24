import type { TransactionSql } from 'postgres';

import { releaseReservation } from './repository';
import type { OrderStatus } from './types';

/**
 * Складско-промо-сетл ВОЗВРАТА в транзакции (БАГ #3/#4, аудит волны 15).
 *
 * Раньше возврат через статус-машину ОПЛАТЫ (UI «Статус оплаты → Возврат») и через
 * webhook Т-Банка REFUNDED менял ТОЛЬКО `payment_status='refunded'`, а компенсация
 * (освобождение резерва остатков, откат промокода, перевод `order.status`) жила
 * исключительно в статус-машине ЗАКАЗА. Итог: резерв навсегда заблокирован (товар
 * нельзя продать), промокод не откатан, заказ остаётся `paid`.
 *
 * Эта функция — единый tx-эффект возврата, ДОПОЛНЯЮЩИЙ обновление `payment_status`
 * (его делает вызывающий). Вызывать ВНУТРИ транзакции вызывающего:
 *  - освобождает удерживаемый резерв (только если он ещё держится — зеркалит
 *    stockEffectFor(from,'refunded'): отгруженный остаток уже списан commit-ом,
 *    трогать нельзя, иначе oversell);
 *  - откатывает применённый промокод (идемпотентно: used_count минус число реально
 *    удалённых редемпшнов — как revertPromoUsage в actions.ts);
 *  - переводит `order.status` в 'refunded' (guarded по прочитанному `from`) + история.
 *
 * Идемпотентно: если заказ уже `refunded`/`cancelled` (или не найден) — НИЧЕГО не делает.
 */

/** Статусы, при которых резерв заказа ещё держится (≡ RESERVE_HELD_STATUSES, actions.ts). */
const RESERVE_HELD: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'new',
  'awaiting_payment',
  'paid',
  'packed',
]);

export async function settleRefundEffectsTx(
  tx: TransactionSql,
  orderId: string,
  actorUserId: string | null,
): Promise<void> {
  const rows = await tx<{ status: OrderStatus; promo_code_id: string | null }[]>`
    SELECT status, promo_code_id FROM orders WHERE id = ${orderId} FOR UPDATE
  `;
  const from = rows[0]?.status;
  // Нет заказа или уже сеттлено (refunded/cancelled) → идемпотентный no-op.
  if (!from || from === 'refunded' || from === 'cancelled') return;

  // (a) Резерв: освобождаем ТОЛЬКО если ещё держится по статусу.
  if (RESERVE_HELD.has(from)) {
    const items = await tx<
      { product_id: string | null; variant_id: string | null; quantity: number }[]
    >`
      SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ${orderId}
    `;
    for (const it of items) {
      if (!it.product_id) continue; // снимок без ссылки — нечего двигать
      await releaseReservation(tx, {
        productId: it.product_id,
        variantId: it.variant_id,
        qty: it.quantity,
      });
    }
  }

  // (b) Откат промокода (идемпотентно).
  const promoCodeId = rows[0]!.promo_code_id;
  if (promoCodeId) {
    const deleted = await tx<{ id: string }[]>`
      DELETE FROM promo_redemptions
       WHERE order_id = ${orderId} AND promo_code_id = ${promoCodeId}
      RETURNING id
    `;
    if (deleted.length > 0) {
      await tx`
        UPDATE promo_codes
           SET used_count = GREATEST(used_count - ${deleted.length}, 0), updated_at = now()
         WHERE id = ${promoCodeId}
      `;
    }
  }

  // (c) order.status → refunded (guarded по from) + история заказа.
  await tx`
    UPDATE orders SET status = 'refunded', updated_at = now()
     WHERE id = ${orderId} AND status = ${from}
  `;
  await tx`
    INSERT INTO order_status_history
      (order_id, kind, from_status, to_status, actor_user_id, comment)
    VALUES
      (${orderId}, 'order', ${from}, 'refunded', ${actorUserId}, 'Возврат оплаты')
  `;
}
