import type { TransactionSql } from 'postgres';

import { releaseReservation } from './repository';
import { releaseGiftTx, revokeIssuedGiftsTx } from '@/lib/gift-certificates/repository';
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
  await settleOrderClosureTx(tx, orderId, {
    to: 'refunded',
    actorUserId,
    comment: 'Возврат оплаты',
  });
}

/**
 * ОБОБЩЁННЫЙ сетл ЗАКРЫТИЯ заказа (возврат ИЛИ отмена) — тело settleRefundEffectsTx.
 *
 * Аудит 2026-07-26 (критичное №4 + major №13) добавил второго потребителя тех же
 * эффектов: авто-отмену просроченного неоплаченного заказа (lib/orders/expire.ts).
 * Брошенный заказ обязан вернуть ровно то же самое — резерв склада, применение
 * промокода, СПИСАННЫЙ БАЛАНС ПОДАРОЧНОГО СЕРТИФИКАТА — но перейти в 'cancelled',
 * а не в 'refunded'. Чтобы не заводить вторую (расходящуюся) копию денежных
 * эффектов, тело вынесено сюда и параметризовано целевым статусом.
 *
 * Идемпотентно и атомарно: строка заказа читается FOR UPDATE, UPDATE гардится по
 * прочитанному `from`, а releaseGiftTx/revokeIssuedGiftsTx/откат промо сами
 * идемпотентны (reversed_at / RETURNING / статус-гард).
 */
export async function settleOrderClosureTx(
  tx: TransactionSql,
  orderId: string,
  opts: {
    /** Терминальный статус закрытия: 'refunded' (возврат) или 'cancelled' (отмена). */
    to: Extract<OrderStatus, 'refunded' | 'cancelled'>;
    actorUserId: string | null;
    /** Комментарий в order_status_history. */
    comment: string;
  },
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

  // (b2) Возврат баланса подарочного сертификата (§5, ADR-P1-3). ОРТОГОНАЛЬНО
  // платёжному провайдеру: заказ мог быть частично покрыт сертификатом + оплачен
  // шлюзом (tbank/paykeeper), либо полностью покрыт сертификатом (provider=manual).
  // releaseGiftTx возвращает spent_total по активным списаниям заказа и метит
  // reversed_at; идемпотентно (повтор/заказ без сертификата → no-op).
  await releaseGiftTx(tx, { orderId });

  // (b3) ГАШЕНИЕ сертификатов, ВЫПУЩЕННЫХ по этому заказу (ТЗ владельца п.11).
  // Зеркало (b2): там возвращается потраченный номинал, здесь отзывается
  // выданный. Иначе покупателю вернули деньги, а код на предъявителя остался
  // рабочим. Гасим БЕЗУСЛОВНО: частично потраченный остаток — не повод оставлять
  // код живым, это лишь предупреждение менеджеру в карточке заказа.
  // Идемпотентно (UPDATE ... WHERE status IN ('active','depleted')).
  await revokeIssuedGiftsTx(tx, { orderId });

  // (c) order.status → to (guarded по from) + история заказа. Литералы 'refunded'/
  // 'cancelled' разведены по веткам намеренно: статус — не пользовательский ввод,
  // а значение из узкого типа; так запрос остаётся статически читаемым (и тесты
  // сторожат его текст), а параметризация значений сохраняется для from/actor.
  if (opts.to === 'refunded') {
    await tx`
      UPDATE orders SET status = 'refunded', updated_at = now()
       WHERE id = ${orderId} AND status = ${from}
    `;
    await tx`
      INSERT INTO order_status_history
        (order_id, kind, from_status, to_status, actor_user_id, comment)
      VALUES
        (${orderId}, 'order', ${from}, 'refunded', ${opts.actorUserId}, ${opts.comment})
    `;
  } else {
    await tx`
      UPDATE orders SET status = 'cancelled', updated_at = now()
       WHERE id = ${orderId} AND status = ${from}
    `;
    await tx`
      INSERT INTO order_status_history
        (order_id, kind, from_status, to_status, actor_user_id, comment)
      VALUES
        (${orderId}, 'order', ${from}, 'cancelled', ${opts.actorUserId}, ${opts.comment})
    `;
  }
}
