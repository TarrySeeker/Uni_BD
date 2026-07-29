'use server';

import type { TransactionSql } from 'postgres';

import { defineAction, type ActionCtx } from '@/lib/server/action';
import { sql } from '@/lib/db/client';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';

import { z } from 'zod';

import {
  ChangeOrderStatusSchema,
  SetPaymentStatusSchema,
  SetDeliveryStatusSchema,
  ManualOrderSchema,
  UpdateOrderContactSchema,
  PromoCreateSchema,
  PromoUpdateSchema,
  PromoIdSchema,
  uuidSchema,
} from './schemas';
import {
  getOrderById,
  releaseReservation,
  commitReservation,
  createOrder,
  type OrderWithItems,
} from './repository';
import { canTransition, paymentStatusOnSettle, RESERVE_HELD_STATUSES } from './status';
import {
  orderStatusLabelKey,
  paymentStatusLabelKey,
  deliveryStatusLabelKey,
} from './labels';
import { isRussianPhone } from './phone';
import { settleOrderClosureTx } from './refund-settle';
import {
  classifyRefundOutcome,
  manualRefundRequiredMessage,
  refundNeedsManualAck,
  refundOutcomeNote,
  type RefundMoneyOutcome,
} from './refund-policy';
import { releaseGiftTx, revokeIssuedGiftsTx } from '@/lib/gift-certificates/repository';
import { autoIssueGiftsForPaidOrder } from '@/lib/gift-certificates/auto-issue';
import { logger } from '@/lib/logger';
import { OrderError } from './errors';
import type { Order, OrderItem, PromoCode } from './types';
import { toKopecks } from '@/lib/payments/tbank';
import { dispatchRefund } from '@/lib/payments/dispatch';

/**
 * ICU-параметры сообщения о КОНКУРЕНТНОЙ смене статуса (аудит minor №7).
 *
 * Раньше в текст подставлялся СЫРОЙ код статуса («переход из "awaiting_payment"»):
 * оператор видел служебную строку вместо человеческой подписи, причём на языке
 * автора кода, а не на своём. Отдаём КЛЮЧ подписи из общей карты lib/orders/labels
 * (единый источник, G-15 — вторая карта здесь НЕ заводится); пайплайн Server Action
 * развернёт ключ в язык оператора перед форматированием сообщения. Незнакомый код
 * (например статус из будущей миграции) отдаём как есть — лучше код, чем пусто.
 */
function conflictParams(labelKey: string | null, code: string): { from: string } {
  return { from: labelKey ?? code };
}


/**
 * Server Actions админки модуля orders (docs/07 §4.1).
 *
 * Все — через единый пайплайн defineAction (§4.7 ядра): guard (orders.read для
 * чтений / orders.write для мутаций) → Zod → handler (БД через sql, в транзакции
 * где нужна атомарность) → revalidate('/admin/orders'*) → audit ('order.*'/'promo.*').
 *
 * Доменные ошибки — через OrderError (errors.ts); недопустимые переходы статусов
 * валидируются canTransition (status.ts) на сервере. При смене статуса заказа
 * пишется order_status_history и (для перехода с резервом остатков) выполняется
 * release/commit на inventory (§6). Эффект зависит от ПАРЫ from→to (anti-oversell,
 * волна 6 — см. stockEffectFor):
 *   • cancel/refund из new/awaiting_payment/paid/packed → releaseReservation
 *     (резерв заказа ещё держится — корректно вернуть);
 *   • → shipped (из packed) → commitReservation (списание остатка);
 *   • refund из shipped/delivered/completed → НИЧЕГО (резерв уже списан commit-ом;
 *     release украл бы чужой резерв; физический restock — отдельная операция).
 *
 * Флаг модуля: каждый handler в начале await assertOrdersEnabled() — авторитетный
 * гейт (env ⊕ БД-оверрайд): выключение из UI отклоняет вызов, а не только скрывает.
 */

// -----------------------------------------------------------------------------
// Общие хелперы.
// -----------------------------------------------------------------------------

/** Бросает, если модуль заказов выключен (env ⊕ БД-оверрайд). */
async function assertOrdersEnabled(): Promise<void> {
  if (!(await isModuleEffectivelyEnabled('orders'))) {
    throw new OrderError('module_disabled', 'Модуль «Заказы» выключен.');
  }
}

/** Пути инвалидации заказов/промокодов. */
const ORDERS_LIST_PATH = '/admin/orders';
function orderPath(id: string): string {
  return `/admin/orders/${id}`;
}
const PROMO_LIST_PATH = '/admin/promo';

/**
 * Схемы отмены/возврата (inline — модуль 'use server' может экспортировать ТОЛЬКО
 * async-функции, поэтому константы-схемы не экспортируем). reason — необязательный
 * комментарий, попадает в order_status_history и audit.
 */
const CancelOrderSchema = z.object({
  id: uuidSchema,
  reason: z.string().trim().max(2000).optional(),
});
const RefundOrderSchema = z.object({
  id: uuidSchema,
  reason: z.string().trim().max(2000).optional(),
  /**
   * 🔴 Подтверждение оператора: «деньги возвращены покупателю ВНЕ системы».
   * Требуется, когда платёжный шлюз возврат не выполняет (заглушка PayKeeper,
   * офлайн/COD, ручной платёж) — иначе возврат отклоняется, чтобы не получилось
   * «бумажного возврата» (аудит 2026-07-26, критичное №7 + major №38). Факт
   * подтверждения уходит в журнал аудита.
   */
  manualRefundAcknowledged: z.boolean().optional(),
});

/** Код нарушения уникальности PostgreSQL (дубликат кода промокода). */
const PG_UNIQUE_VIOLATION = '23505';
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

// -----------------------------------------------------------------------------
// Ядро смены статуса заказа (транзакция: проверка перехода + резерв + история).
// -----------------------------------------------------------------------------

/** Действие над резервом остатков при переходе статуса заказа (§6). */
type StockEffect = 'none' | 'release' | 'commit';

/**
 * Статусы заказа, ДО входа в которые резерв этого заказа ещё ДЕРЖИТСЯ на
 * inventory (reserved += qty при createOrder, ещё НЕ списан commit-ом). commit
 * выполняется ровно при входе в 'shipped' (см. ниже), поэтому из этих статусов
 * cancel/refund обязан вернуть резерв (release).
 *
 * Список переехал в status.ts (RESERVE_HELD_STATUSES / OPEN_ORDER_STATUSES):
 * тот же самый набор нужен гейту удаления товара/варианта в каталоге
 * (аудит-находка #9), а две копии разъехались бы.
 */

/**
 * Какое действие над резервом выполнять при переходе `from → to` (§6).
 *
 * ВАЖНО (CRITICAL, волна 6, anti-oversell): эффект 'release' для cancel/refund
 * зависит НЕ только от `to`, но и от `from`. На входе в 'shipped' выполняется
 * commitReservation (quantity-=qty, reserved-=qty) — резерв ЭТОГО заказа уже
 * СПИСАН. releaseReservation гардит по ГЛОБАЛЬНОМУ агрегату строки inventory
 * (WHERE reserved >= qty) без привязки к заказу (per-order резерва в схеме 0010
 * нет — хранятся только агрегатные quantity/reserved). Поэтому release при
 * refund/cancel из shipped/delivered/completed НЕ нашёл бы «свой» резерв (он уже
 * списан commit-ом), но при наличии резерва ДРУГИХ открытых заказов на том же
 * SKU гард прошёл бы и release украл ЧУЖОЙ резерв → повреждение резервов чужих
 * заказов + oversell (CHECK inventory_reserved_le_qty это не ловит).
 *
 * Поэтому:
 *   • from ∈ RESERVE_HELD (new/awaiting_payment/paid/packed) + to cancelled/
 *     refunded → 'release': резерв заказа ещё держится, корректно вернуть его;
 *   • from ∈ {shipped, delivered, completed} + to refunded → 'none': резерв уже
 *     списан commit-ом, трогать reserved НЕЛЬЗЯ. Физический возврат товара на
 *     склад (restock: quantity += qty) — ОТДЕЛЬНАЯ операция, здесь её НЕ делаем
 *     намеренно: консервативно не раздуваем остаток товаром, который мог не
 *     вернуться физически (приёмка/осмотр возврата — вне этого перехода);
 *   • to 'shipped' (из packed) → 'commit': списание остатка при отгрузке.
 */
function stockEffectFor(from: Order['status'], to: Order['status']): StockEffect {
  if (to === 'cancelled' || to === 'refunded') {
    return RESERVE_HELD_STATUSES.has(from) ? 'release' : 'none';
  }
  if (to === 'shipped') return 'commit';
  return 'none';
}

/**
 * Применяет переход статуса заказа атомарно и БЕЗ TOCTOU-гонки (§2.8 A, §6):
 *   1) загружает заказ + позиции (кандидат `from` и снимок позиций для резерва);
 *   2) валидирует переход canTransition('order', from, to) — иначе OrderError;
 *   3) ТРАНЗАКЦИЯ:
 *      a) GUARDED UPDATE orders ... WHERE id=:id AND status=:from RETURNING id —
 *         переход проходит ТОЛЬКО если статус всё ещё равен прочитанному `from`.
 *         Если affected rows ≠ 1 → конкурентный переход уже сменил статус →
 *         OrderError('conflict') и ROLLBACK (без побочных эффектов/истории).
 *         Это закрывает гонку: два параллельных перехода из одного `from`
 *         сериализуются на блокировке строки orders (UPDATE), и второй увидит
 *         уже изменённый статус → 0 строк → конфликт;
 *      b) резерв/списание по позициям (release/commit) — ТОЛЬКО при успешном
 *         guarded UPDATE (в той же транзакции, откат вместе);
 *      c) откат промокода для cancelled/refunded (Fix 4, см. revertPromoUsage);
 *      d) INSERT order_status_history (from→to, actor, comment).
 *
 * NB: полноценная конкурентность проверяется интеграционным тестом с реальной БД
 * (repository.test.ts, skipIf без DATABASE_URL); здесь юнит-логика guarded-UPDATE
 * проверяется по affected rows (мок tx).
 *
 * Возвращает before/after для аудита и обновлённый заказ.
 */
/**
 * Автовыпуск сертификатов ПОСЛЕ КОММИТА перехода оплаты (ТЗ владельца п.11).
 *
 * 🔴 Только вне транзакции: выпуск открывает СВОИ транзакции, а исключение
 * внутри транзакции фиксации оплаты откатило бы сам факт оплаты. Конвейер и сам
 * не бросает — обёртка страхует границу (сеть/пул) и гарантирует, что сбой
 * выпуска не превратится в отказ основной операции.
 */
async function autoIssueGiftsAfterCommit(orderId: string): Promise<void> {
  try {
    await autoIssueGiftsForPaidOrder(orderId);
  } catch (err) {
    logger.error('автовыпуск сертификатов не выполнен', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function applyOrderStatusTransition(args: {
  id: string;
  to: Order['status'];
  comment: string;
  actorUserId: string | null;
  /**
   * Уже загруженный заказ (опц.): refundOrder загружает заказ заранее для шлюзового
   * возврата и передаёт его сюда, чтобы НЕ дублировать SELECT. Без preloaded —
   * загружаем сами (поведение прочих переходов не меняется).
   */
  preloaded?: OrderWithItems;
  /**
   * Разрешить переход, даже если списать резерв по позиции не удалось
   * (аудит-находка #9). Влияет ТОЛЬКО на эффект 'commit' и ТОЛЬКО на те позиции,
   * по которым commitReservation вернул false; всё остальное (валидация
   * перехода, guarded UPDATE, release, промо, сертификаты) работает как обычно.
   */
  forceStockCommit?: boolean;
  /**
   * 🔴 ДЕНЬГИ. Подтверждение вызывающего, что судьба денег УЖЕ решена денежным
   * путём (performRefund: обращение к платёжному шлюзу + классификация исхода +
   * подтверждение ручного возврата). Только с этим флагом переход имеет право
   * проставить payment_status='refunded'.
   *
   * Без флага любой переход, который по paymentStatusOnSettle пометил бы деньги
   * возвращёнными (отмена/возврат ОПЛАЧЕННОГО заказа), отклоняется — см. гард
   * ниже. Это закрывает «бумажный возврат» (аудит 2026-07-26, критичное №7):
   * заказ становился терминальным с payment_status='refunded', а перевода в банк
   * не было и сделать его было уже нечем.
   */
  moneySettled?: boolean;
}): Promise<{ before: Order; after: OrderWithItems; forcedSkips: string[] }> {
  const current = args.preloaded ?? (await getOrderById(args.id));
  if (!current) {
    throw new OrderError('not_found', 'Заказ не найден.');
  }
  const from = current.order.status;
  if (!canTransition('order', from, args.to)) {
    throw new OrderError(
      'invalid_transition',
      `Недопустимый переход статуса заказа: "${from}" → "${args.to}".`,
    );
  }

  const effect = stockEffectFor(from, args.to);
  const promoCodeId = current.order.promoCodeId;
  const revertPromo = args.to === 'cancelled' || args.to === 'refunded';

  // Сетл оплаты при отмене/возврате: 'refunded' ТОЛЬКО для реально оплаченного
  // (payment='paid'); для pending/failed/authorized — не трогаем (см.
  // paymentStatusOnSettle). Это чинит «отмену оплаченного без возврата» и
  // ложный refunded по COD одновременно.
  const fromPayment = current.order.paymentStatus;
  const toPayment = paymentStatusOnSettle(fromPayment, args.to);

  // 🔴 ГАРД «БУМАЖНОГО ВОЗВРАТА» (критичное №7). Пометить деньги возвращёнными
  // может ТОЛЬКО денежный путь performRefund — он обращается к платёжному шлюзу,
  // классифицирует реальный исход и требует подтверждения, если шлюз возврат не
  // выполняет. Отмена оплаченного заказа и changeOrderStatus сюда не проходят:
  // иначе заказ становился терминальным с payment_status='refunded' БЕЗ перевода
  // денег, а инициировать настоящий возврат было уже нечем (refunded/cancelled —
  // терминальны). Неоплаченные заказы (COD/pending/failed) не затронуты:
  // paymentStatusOnSettle отдаёт для них null.
  if (toPayment === 'refunded' && args.moneySettled !== true) {
    throw new OrderError(
      'refund_required',
      'Заказ оплачен: пометить деньги возвращёнными в обход платёжного шлюза нельзя. ' +
        'Используйте действие «Возврат» — оно обращается к шлюзу, фиксирует исход в ' +
        'журнале и требует подтверждения, если перевод придётся сделать вручную.',
    );
  }

  /**
   * SKU позиций, по которым списание остатка НЕ прошло и было пропущено по
   * явному распоряжению оператора (forceStockCommit). Наполняется внутри
   * транзакции; чистится на входе, чтобы повторный прогон колбэка (ретрай
   * драйвера) не накопил дублей.
   */
  const forcedSkips: string[] = [];

  await sql.begin(async (tx: TransactionSql) => {
    forcedSkips.length = 0;
    // (a) GUARDED UPDATE: переход применяется ТОЛЬКО если статус не сменился
    // конкурентным запросом (WHERE ... AND status = from). 0 строк → конфликт.
    const updated = toPayment
      ? await tx<{ id: string }[]>`
          UPDATE orders
             SET status = ${args.to}, payment_status = ${toPayment}, updated_at = now()
           WHERE id = ${args.id} AND status = ${from}
          RETURNING id
        `
      : await tx<{ id: string }[]>`
          UPDATE orders
             SET status = ${args.to}, updated_at = now()
           WHERE id = ${args.id} AND status = ${from}
          RETURNING id
        `;
    if (updated.length !== 1) {
      throw new OrderError(
        'conflict',
        'errors.orders.conflictOrderStatus',
        conflictParams(orderStatusLabelKey(from), from),
      );
    }

    // (b) Резерв/списание по каждой позиции — только после успешного перехода.
    // effect учитывает `from` (см. stockEffectFor): release делается ТОЛЬКО когда
    // резерв заказа ещё держится (from ∈ RESERVE_HELD). При refund отгруженного
    // (from ∈ shipped/delivered/completed) effect='none' — резерв уже списан
    // commit-ом, его нельзя трогать (иначе украли бы чужой резерв → oversell).
    // commit обязан списать → иначе ROLLBACK.
    if (effect !== 'none') {
      for (const item of current.items) {
        if (!item.productId) continue; // снимок без ссылки — нечего двигать
        const unit = {
          productId: item.productId,
          variantId: item.variantId,
          qty: item.quantity,
        };
        if (effect === 'release') {
          await releaseReservation(tx, unit);
        } else {
          const ok = await commitReservation(tx, unit);
          if (!ok) {
            // Тупик #9: строки остатка может не быть вовсе (вариант удалён из
            // каталога → inventory снесён каскадом вместе с резервом), и тогда
            // списывать физически нечего — обычная повторная попытка будет
            // падать ВЕЧНО. Осознанный форс оператора пропускает такую позицию,
            // но громко: SKU уходит в историю заказа и в аудит.
            if (!args.forceStockCommit) {
              throw new OrderError(
                'commit_failed',
                `Не удалось списать остаток позиции ${item.skuSnapshot}: строка остатка недоступна ` +
                  `(например, вариант удалён из каталога). Проверьте остаток или отгрузите без списания.`,
              );
            }
            forcedSkips.push(item.skuSnapshot);
          }
        }
      }
    }

    // (c) Откат применения промокода при отмене/возврате (Fix 4) — в той же
    // транзакции, идемпотентно (только если редемпшн ещё существует).
    if (revertPromo && promoCodeId) {
      await revertPromoUsage(tx, args.id, promoCodeId);
    }

    // (c2) Возврат баланса подарочного сертификата при отмене/возврате (§5).
    // Этот путь (admin refund/cancel) НЕ проходит через settleRefundEffectsTx, но
    // резерв/промо/статус сеттлит здесь же — сертификат восстанавливаем симметрично.
    // releaseGiftTx идемпотентна (reversed_at) и no-op для заказа без сертификата,
    // поэтому двойного возврата с webhook-путём (settleRefundEffectsTx) не будет.
    if (revertPromo) {
      await releaseGiftTx(tx, { orderId: args.id });
      // (c3) И симметрично гасим коды, ВЫПУЩЕННЫЕ по этому заказу (ТЗ п.11):
      // возврат/отмена не должны оставлять на руках рабочий код на предъявителя.
      // Внутри транзакции перехода намеренно: не состоялся возврат — не состоялось
      // и гашение. Идемпотентно (гасит только active/depleted).
      await revokeIssuedGiftsTx(tx, { orderId: args.id });
    }

    // (d) История статуса заказа. Пропущенные списания дописываются в тот же
    // комментарий — иначе по ленте заказа было бы не видно, что остаток по этим
    // SKU остался несписанным (расхождение склада нужно объяснимым, а не тихим).
    const historyComment =
      forcedSkips.length > 0
        ? `${args.comment} [отгружено без списания остатка: ${forcedSkips.join(', ')}]`.trim()
        : args.comment;
    await tx`
      INSERT INTO order_status_history
        (order_id, kind, from_status, to_status, actor_user_id, comment)
      VALUES
        (${args.id}, 'order', ${from}, ${args.to}, ${args.actorUserId}, ${historyComment})
    `;

    // (d2) История ОПЛАТЫ — когда отмена/возврат повлёк возврат денег
    // (paid → refunded). Без этой записи возврат не виден в истории/отчётности.
    if (toPayment) {
      await tx`
        INSERT INTO order_status_history
          (order_id, kind, from_status, to_status, actor_user_id, comment)
        VALUES
          (${args.id}, 'payment', ${fromPayment}, ${toPayment}, ${args.actorUserId}, ${args.comment})
      `;
    }
  });

  if (forcedSkips.length > 0) {
    logger.warn('переход статуса выполнен БЕЗ списания остатка', {
      orderId: args.id,
      to: args.to,
      skus: forcedSkips,
      actorUserId: args.actorUserId,
    });
  }

  const after = await getOrderById(args.id);
  if (!after) {
    throw new OrderError('not_found', 'Заказ не найден после обновления.');
  }
  return { before: current.order, after, forcedSkips };
}

/**
 * Откатывает применение промокода при отмене/возврате заказа (Fix 4, §5.2).
 * ВЫЗЫВАТЬ В ТРАНЗАКЦИИ. Идемпотентно: used_count уменьшается ровно столько раз,
 * сколько реально удалено строк promo_redemptions данного заказа (DELETE ...
 * RETURNING). Повторная отмена/возврат уже без редемпшна → удалено 0 строк →
 * used_count не трогаем. GREATEST(...,0) — страховка от ухода счётчика в минус.
 */
async function revertPromoUsage(
  tx: TransactionSql,
  orderId: string,
  promoCodeId: string,
): Promise<void> {
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

/** Сериализуемый снимок заказа для возврата из action. */
function orderDetailResult(detail: OrderWithItems): {
  order: Order;
  items: OrderItem[];
} {
  return { order: detail.order, items: detail.items };
}

// =============================================================================
// ЧТЕНИЕ (orders.read).
// =============================================================================

export const getOrder = defineAction({
  permission: 'orders.read',
  input: PromoIdSchema, // { id: uuid } — та же форма «по id»
  handler: async (data, _ctx: ActionCtx) => {
    await assertOrdersEnabled();
    const detail = await getOrderById(data.id);
    if (!detail) {
      throw new OrderError('not_found', 'Заказ не найден.');
    }
    return { result: orderDetailResult(detail) };
  },
});

// =============================================================================
// СМЕНА СТАТУСА ЗАКАЗА (orders.write) — §2.8 A, §6.
// =============================================================================

export const changeOrderStatus = defineAction({
  permission: 'orders.write',
  input: ChangeOrderStatusSchema,
  handler: async (data, ctx) => {
    await assertOrdersEnabled();
    const { before, after, forcedSkips } = await applyOrderStatusTransition({
      id: data.id,
      to: data.to,
      comment: data.comment ?? '',
      actorUserId: ctx.user.id,
      forceStockCommit: data.forceStockCommit === true,
    });
    return {
      result: orderDetailResult(after),
      revalidate: [ORDERS_LIST_PATH, orderPath(data.id)],
      audit: {
        action: 'order.status.change',
        entityType: 'order',
        entityId: data.id,
        before: { status: before.status },
        // forcedStockCommit — поимённый список SKU, отгруженных БЕЗ списания
        // остатка (пусто при обычной отгрузке). Расхождение склада обязано быть
        // видно в журнале, иначе «форс» превратится в тихую дыру в учёте.
        after: { status: after.order.status, forcedStockCommit: forcedSkips },
      },
    };
  },
});

export const cancelOrder = defineAction({
  permission: 'orders.write',
  input: CancelOrderSchema,
  handler: async (data, ctx) => {
    await assertOrdersEnabled();
    const { before, after } = await applyOrderStatusTransition({
      id: data.id,
      to: 'cancelled',
      comment: data.reason ?? '',
      actorUserId: ctx.user.id,
    });
    return {
      result: orderDetailResult(after),
      revalidate: [ORDERS_LIST_PATH, orderPath(data.id)],
      audit: {
        action: 'order.cancel',
        entityType: 'order',
        entityId: data.id,
        before: { status: before.status },
        after: { status: after.order.status },
      },
    };
  },
});

/**
 * 🔴 ЕДИНСТВЕННЫЙ ДЕНЕЖНЫЙ ПУТЬ ВОЗВРАТА (аудит 2026-07-26: критичное №7, major №38).
 *
 * Раньше «возврат» существовал в трёх видах с разными последствиями: refundOrder
 * (дёргал шлюз), setPaymentStatus→refunded и отмена оплаченного заказа (штамповали
 * payment_status='refunded' БЕЗ шлюза). После любого из них заказ становился
 * терминальным, а настоящий возврат — недоступным: покупатель без денег, система
 * считает возврат состоявшимся. Теперь любая пометка «деньги возвращены» проходит
 * ЗДЕСЬ, а applyOrderStatusTransition принимает её только с moneySettled.
 *
 * Порядок (важен):
 *   1) ЗАКРЫТЫЙ заказ / уже возвращённая оплата → отказ ДО шлюза (идемпотентность:
 *      повторное нажатие не делает второй reverse и не возвращает баланс дважды);
 *   2) переход в 'refunded' должен быть либо допустим статус-машиной, либо заказ
 *      РЕАЛЬНО оплачен (payment='paid'): второй случай — штатный «Т-Банк CONFIRMED
 *      пометил оплату, не двигая order.status», и без него оплаченный заказ в
 *      статусе 'new' было бы не вернуть вовсе (тупик). Для НЕоплаченных заказов
 *      предпроверка сохраняется как была (холд/деньги не трогаем зря);
 *   3) обращение к шлюзу через dispatchRefund (маршрут по payment_provider);
 *   4) КЛАССИФИКАЦИЯ фактического исхода (шлюз вернул / нужен ручной перевод /
 *      возвращать нечего / шлюз отказал) и требование подтверждения оператора,
 *      когда деньги придётся возвращать руками;
 *   5) сетл: переход заказа в 'refunded' (moneySettled) либо — если статус-машина
 *      этого не позволяет — прямой сетл оплаты + закрытие заказа в одной транзакции.
 *
 * Возвращает данные для аудита: денежный исход и трассировку шлюза.
 */
async function performRefund(args: {
  id: string;
  reason?: string;
  /** Оператор подтвердил, что деньги возвращены ВНЕ системы (перевод/касса). */
  manualAck: boolean;
  actorUserId: string | null;
  /** Уже загруженный заказ (setPaymentStatus читает его для валидации перехода). */
  preloaded?: OrderWithItems;
}): Promise<{
  before: Order;
  after: OrderWithItems;
  outcome: RefundMoneyOutcome;
  gateway: { status: string | null; skipped: boolean; isMock: boolean; reason?: string };
}> {
  const cur = args.preloaded ?? (await getOrderById(args.id));
  if (!cur) {
    throw new OrderError('not_found', 'Заказ не найден.');
  }
  const order = cur.order;

  // (1) Заказ уже закрыт / оплата уже возвращена → второй раз не возвращаем.
  if (order.status === 'cancelled' || order.status === 'refunded') {
    throw new OrderError(
      'order_closed',
      `Заказ уже ${order.status === 'cancelled' ? 'отменён' : 'возвращён'}: ` +
        'повторный возврат невозможен.',
    );
  }
  if (order.paymentStatus === 'refunded') {
    throw new OrderError('already_refunded', 'Возврат оплаты по этому заказу уже оформлен.');
  }

  // (2) Допустимость возврата. Оплаченный заказ возвращаем всегда (иначе тупик),
  // неоплаченный — только по статус-машине (предпроверка ДО шлюза сохранена).
  const canSettleByTransition = canTransition('order', order.status, 'refunded');
  if (!canSettleByTransition && order.paymentStatus !== 'paid') {
    throw new OrderError(
      'invalid_transition',
      `Недопустимый переход статуса заказа: "${order.status}" → "refunded".`,
    );
  }

  // (3) ШЛЮЗОВОЙ ВОЗВРАТ (ADR-P1-3): маршрут по order.payment_provider; неизвестный
  // НЕ-null провайдер → безопасная ошибка (НЕ дефолт-tbank). Суммы СЕРВЕРНЫЕ
  // (копейки из grand_total, anti-tamper). payment_status шлюз НЕ меняет.
  const amountKop = toKopecks(order.grandTotal);
  const gateway = await dispatchRefund({
    orderId: order.id,
    orderNumber: order.number,
    paymentStatus: order.paymentStatus,
    paymentProvider: order.paymentProvider ?? null,
    paymentRef: order.paymentRef,
    amountKop,
  });

  // (4) Что РЕАЛЬНО произошло с деньгами.
  const outcome = classifyRefundOutcome({
    paymentStatus: order.paymentStatus,
    amountKop,
    gateway,
  });

  if (outcome === 'gateway_failed') {
    throw new OrderError(
      'payment_refund_failed',
      'Не удалось вернуть оплату через платёжный шлюз. Возврат заказа отменён, повторите позже.',
    );
  }

  // Деньги получены, а шлюз их не вернёт (заглушка PayKeeper / офлайн / COD-оплата
  // наличными): без явного подтверждения оператора НЕ помечаем заказ возвращённым —
  // это и есть «бумажный возврат». Ни одного эффекта ещё не применено (шлюз пропущен).
  if (refundNeedsManualAck(outcome) && !args.manualAck) {
    throw new OrderError(
      'manual_refund_required',
      manualRefundRequiredMessage({
        paymentProvider: order.paymentProvider ?? null,
        amountLabel: `${order.grandTotal} ${order.currency}`,
      }),
    );
  }

  // (5) Сетл. Денежный след пишем в комментарий истории: по ленте заказа должно
  // быть видно, ушли деньги через шлюз или их вернули вручную.
  const note = refundOutcomeNote(outcome);
  const comment = args.reason ? `${args.reason} — ${note}` : note;
  const gatewayTrace = {
    status: gateway.status,
    skipped: gateway.skipped ?? false,
    isMock: gateway.isMock,
    reason: gateway.reason,
  };

  if (canSettleByTransition) {
    const { before, after } = await applyOrderStatusTransition({
      id: args.id,
      to: 'refunded',
      comment,
      actorUserId: args.actorUserId,
      preloaded: cur,
      moneySettled: true,
    });
    return { before, after, outcome, gateway: gatewayTrace };
  }

  // ФОЛБЭК: заказ РЕАЛЬНО оплачен, но order.status ещё не дошёл до состояния, из
  // которого статус-машина допускает 'refunded' (вебхук эквайера ставит
  // payment_status='paid', не продвигая заказ). Без этой ветки такой заказ было бы
  // не вернуть вовсе. Одна транзакция: guarded сетл оплаты + закрытие заказа
  // (резерв, промокод, БАЛАНС СЕРТИФИКАТА, гашение выпущенных кодов).
  const fromPayment = order.paymentStatus;
  await sql.begin(async (tx: TransactionSql) => {
    const updated = await tx<{ id: string }[]>`
      UPDATE orders
         SET payment_status = 'refunded', updated_at = now()
       WHERE id = ${args.id} AND payment_status = ${fromPayment}
      RETURNING id
    `;
    if (updated.length !== 1) {
      throw new OrderError(
        'conflict',
        'errors.orders.conflictPaymentStatus',
        conflictParams(paymentStatusLabelKey(fromPayment), fromPayment),
      );
    }
    await tx`
      INSERT INTO order_status_history
        (order_id, kind, from_status, to_status, actor_user_id, comment)
      VALUES
        (${args.id}, 'payment', ${fromPayment}, 'refunded', ${args.actorUserId}, ${comment})
    `;
    await settleOrderClosureTx(tx, args.id, {
      to: 'refunded',
      actorUserId: args.actorUserId,
      comment,
    });
  });

  const after = await getOrderById(args.id);
  if (!after) {
    throw new OrderError('not_found', 'Заказ не найден после обновления.');
  }
  return { before: order, after, outcome, gateway: gatewayTrace };
}

/** Аудит-запись денежного возврата: исход + трассировка шлюза + факт подтверждения. */
function refundAuditEntry(input: {
  action: 'order.refund';
  orderId: string;
  before: Order;
  after: OrderWithItems;
  outcome: RefundMoneyOutcome;
  gateway: { status: string | null; skipped: boolean; isMock: boolean; reason?: string };
  manualAck: boolean;
}) {
  return {
    action: input.action,
    entityType: 'order' as const,
    entityId: input.orderId,
    before: { status: input.before.status, paymentStatus: input.before.paymentStatus },
    after: {
      status: input.after.order.status,
      paymentStatus: input.after.order.paymentStatus,
      // Трассировка возврата: по журналу обязано быть видно, ушли ли деньги.
      gatewayRefund: {
        status: input.gateway.status,
        skipped: input.gateway.skipped,
        isMock: input.gateway.isMock,
        reason: input.gateway.reason ?? null,
        outcome: input.outcome,
        // true → деньги возвращены ВНЕ системы под ответственность оператора.
        manualAcknowledged: input.manualAck && input.outcome === 'manual_required',
      },
    },
  };
}

export const refundOrder = defineAction({
  permission: 'orders.write',
  input: RefundOrderSchema,
  handler: async (data, ctx) => {
    await assertOrdersEnabled();
    const { before, after, outcome, gateway } = await performRefund({
      id: data.id,
      reason: data.reason,
      manualAck: data.manualRefundAcknowledged === true,
      actorUserId: ctx.user.id,
    });
    return {
      result: orderDetailResult(after),
      revalidate: [ORDERS_LIST_PATH, orderPath(data.id)],
      audit: refundAuditEntry({
        action: 'order.refund',
        orderId: data.id,
        before,
        after,
        outcome,
        gateway,
        manualAck: data.manualRefundAcknowledged === true,
      }),
    };
  },
});

// =============================================================================
// СМЕНА СТАТУСА ОПЛАТЫ (orders.write) — §2.8 B, mock/ручной.
// =============================================================================

export const setPaymentStatus = defineAction({
  permission: 'orders.write',
  input: SetPaymentStatusSchema,
  handler: async (data, ctx) => {
    await assertOrdersEnabled();
    const current = await getOrderById(data.id);
    if (!current) {
      throw new OrderError('not_found', 'Заказ не найден.');
    }
    const from = current.order.paymentStatus;
    if (!canTransition('payment', from, data.to)) {
      throw new OrderError(
        'invalid_transition',
        `Недопустимый переход статуса оплаты: "${from}" → "${data.to}".`,
      );
    }

    // C5-1 (регресс C4-1, аудит цикла 5 — ДЕНЬГИ/anti-tamper): гард мёртвого заказа на
    // АДМИН-пути, зеркало webhook-сетла (applyPaymentStatusTx). Пометить оплату
    // paid/authorized для ОТМЕНЁННОГО/ВОЗВРАЩЁННОГО заказа нельзя — заказ мёртв, резерв
    // отпущен. C4-1 закрыл только webhook-путь, этот ручной путь оставался открыт.
    // Возврат (refunded) НЕ блокируем — он легитимно делегируется сетлу заказа ниже.
    if (
      (data.to === 'paid' || data.to === 'authorized') &&
      (current.order.status === 'cancelled' || current.order.status === 'refunded')
    ) {
      throw new OrderError(
        'invalid_order_state',
        `Нельзя пометить оплату «${data.to}» для ${
          current.order.status === 'cancelled' ? 'отменённого' : 'возвращённого'
        } заказа.`,
      );
    }

    // 🔴 ВОЗВРАТ ОПЛАТЫ = ДЕНЕЖНАЯ ОПЕРАЦИЯ, А НЕ СМЕНА СТАТУСА (критичное №7).
    // Раньше эта ветка (и fall-through ниже) штамповала payment_status='refunded'
    // БЕЗ обращения к платёжному шлюзу — «Статус оплаты → Возврат» и «Статус заказа
    // → Возврат» выглядели одинаково, но означали разное: деньги оставались у
    // магазина, а заказ становился терминальным, и настоящий возврат был уже
    // недоступен. Теперь оба входа ведут в ОДИН исполнитель performRefund: шлюз,
    // классификация исхода, подтверждение ручного перевода, единый след в аудите.
    if (data.to === 'refunded') {
      const { before, after, outcome, gateway } = await performRefund({
        id: data.id,
        reason: data.comment,
        manualAck: data.manualRefundAcknowledged === true,
        actorUserId: ctx.user.id,
        preloaded: current, // заказ уже прочитан выше — без второго SELECT
      });
      return {
        result: orderDetailResult(after),
        revalidate: [ORDERS_LIST_PATH, orderPath(data.id)],
        audit: refundAuditEntry({
          action: 'order.refund',
          orderId: data.id,
          before,
          after,
          outcome,
          gateway,
          manualAck: data.manualRefundAcknowledged === true,
        }),
      };
    }

    await sql.begin(async (tx: TransactionSql) => {
      // GUARDED UPDATE (Fix 1, TOCTOU): переход применяется только если
      // payment_status всё ещё равен прочитанному `from`; иначе конкурентный
      // переход уже сменил статус → 0 строк → конфликт, ROLLBACK (нет истории).
      // paid проставляет paid_at (§2.8 B); прочие переходы не трогают paid_at.
      const updated =
        data.to === 'paid'
          ? await tx<{ id: string }[]>`
              UPDATE orders
                 SET payment_status = ${data.to}, paid_at = now(), updated_at = now()
               WHERE id = ${data.id} AND payment_status = ${from}
              RETURNING id
            `
          : await tx<{ id: string }[]>`
              UPDATE orders
                 SET payment_status = ${data.to}, updated_at = now()
               WHERE id = ${data.id} AND payment_status = ${from}
              RETURNING id
            `;
      if (updated.length !== 1) {
        throw new OrderError(
          'conflict',
          'errors.orders.conflictPaymentStatus',
          conflictParams(paymentStatusLabelKey(from), from),
        );
      }
      await tx`
        INSERT INTO order_status_history
          (order_id, kind, from_status, to_status, actor_user_id, comment)
        VALUES
          (${data.id}, 'payment', ${from}, ${data.to}, ${ctx.user.id}, ${data.comment ?? ''})
      `;
      // NB: ветки `to === 'refunded'` здесь БОЛЬШЕ НЕТ — возврат целиком уехал в
      // performRefund (выше), вместе с обязательным обращением к шлюзу и сетлом
      // закрытия заказа. Сюда доходят только неденежные переходы оплаты.
    });

    // ПОСЛЕ КОММИТА: переход в paid реально применён (guarded UPDATE выше иначе
    // бросил бы conflict) → выпускаем сертификаты по позициям-сертификатам.
    if (data.to === 'paid') {
      await autoIssueGiftsAfterCommit(data.id);
    }

    const after = await getOrderById(data.id);
    return {
      result: orderDetailResult(after!),
      revalidate: [ORDERS_LIST_PATH, orderPath(data.id)],
      audit: {
        action: 'order.payment.change',
        entityType: 'order',
        entityId: data.id,
        before: { paymentStatus: from },
        after: { paymentStatus: data.to },
      },
    };
  },
});

// =============================================================================
// СМЕНА СТАТУСА ДОСТАВКИ (orders.write) — §2.8 C; Этап 4 синхронизирует со СДЭК.
// =============================================================================

export const setDeliveryStatus = defineAction({
  permission: 'orders.write',
  input: SetDeliveryStatusSchema,
  handler: async (data, ctx) => {
    await assertOrdersEnabled();
    const current = await getOrderById(data.id);
    if (!current) {
      throw new OrderError('not_found', 'Заказ не найден.');
    }
    const from = current.order.deliveryStatus;
    if (!canTransition('delivery', from, data.to)) {
      throw new OrderError(
        'invalid_transition',
        `Недопустимый переход статуса доставки: "${from}" → "${data.to}".`,
      );
    }

    await sql.begin(async (tx: TransactionSql) => {
      // GUARDED UPDATE (Fix 1, TOCTOU): применяется только если delivery_status
      // всё ещё равен прочитанному `from`; иначе конфликт → ROLLBACK (нет истории).
      const updated = await tx<{ id: string }[]>`
        UPDATE orders
           SET delivery_status = ${data.to}, updated_at = now()
         WHERE id = ${data.id} AND delivery_status = ${from}
        RETURNING id
      `;
      if (updated.length !== 1) {
        throw new OrderError(
          'conflict',
          'errors.orders.conflictDeliveryStatus',
          conflictParams(deliveryStatusLabelKey(from), from),
        );
      }
      await tx`
        INSERT INTO order_status_history
          (order_id, kind, from_status, to_status, actor_user_id, comment)
        VALUES
          (${data.id}, 'delivery', ${from}, ${data.to}, ${ctx.user.id}, ${data.comment ?? ''})
      `;
    });

    const after = await getOrderById(data.id);
    return {
      result: orderDetailResult(after!),
      revalidate: [ORDERS_LIST_PATH, orderPath(data.id)],
      audit: {
        action: 'order.delivery.change',
        entityType: 'order',
        entityId: data.id,
        before: { deliveryStatus: from },
        after: { deliveryStatus: data.to },
      },
    };
  },
});

// =============================================================================
// РУЧНОЕ СОЗДАНИЕ ЗАКАЗА (orders.write) — source='admin', §4.1.
// =============================================================================

export const createManualOrder = defineAction({
  permission: 'orders.write',
  input: ManualOrderSchema,
  handler: async (data, ctx) => {
    await assertOrdersEnabled();
    // Та же серверная ре-валидация цен/остатков/резерв, что у витрины (ADR-010),
    // но с источником 'admin' и actorUserId для истории.
    const created = await createOrder(data, {
      source: 'admin',
      ip: ctx.ip || null,
      actorUserId: ctx.user.id,
    });
    if (!created.ok) {
      throw new OrderError(created.code, created.message);
    }
    return {
      result: { id: created.order.id, number: created.order.number, order: created.order },
      revalidate: [ORDERS_LIST_PATH, orderPath(created.order.id)],
      audit: {
        action: 'order.create.manual',
        entityType: 'order',
        entityId: created.order.id,
        after: {
          number: created.order.number,
          grandTotal: created.order.grandTotal,
          source: created.order.source,
        },
      },
    };
  },
});

// =============================================================================
// ПРАВКА КОНТАКТОВ ЗАКАЗА (orders.write) — выход из тупика #8.
// =============================================================================

/** Статусы, в которых заказ считается закрытым и контакты уже не редактируются. */
const CONTACT_LOCKED_STATUSES: ReadonlySet<Order['status']> = new Set<Order['status']>([
  'cancelled',
  'refunded',
]);

/**
 * Правка контактов покупателя и адреса доставки уже созданного заказа.
 *
 * ЗАЧЕМ (аудит-находка #8). В модуле не было НИ ОДНОГО экшена правки полей
 * заказа. Покупатель, указавший городской номер «2223344», спокойно проходил и
 * Zod, и проверку витрины, оплачивал заказ — а затем «Создать отправление»
 * навсегда падало на нормализации телефона СДЭК. Оплаченный заказ нельзя было
 * ни отгрузить, ни починить: оставалось вернуть деньги или лезть в БД руками.
 *
 * ГРАНИЦЫ (сознательно узкие):
 *   • правятся ТОЛЬКО операционные контакты и адрес. Позиции, цены, суммы,
 *     промокод, сертификат и статусы — снимок сделки (ADR-010) и правятся
 *     своими путями;
 *   • стоимость доставки НЕ пересчитывается: заказ уже оплачен на согласованную
 *     сумму, тихо менять её задним числом нельзя. Смена города — операционное
 *     решение менеджера, поэтому оно поимённо пишется в аудит;
 *   • закрытые заказы (отменён/возврат) не редактируются: это уже история;
 *   • курьерская доставка без адреса запрещена — иначе накладную снова не
 *     создать, то есть мы бы починили один тупик и открыли другой.
 *
 * Телефон валидируется МЯГКО (см. schemas.phoneSchema): российский формат не
 * навязывается, потому что магазин трёхъязычный, а СДЭК — лишь один из способов
 * доставки. Пригодность номера для накладной показывается предупреждением в
 * карточке заказа (isRussianPhone), и это возвращается вызывающему.
 */
export const updateOrderContact = defineAction({
  permission: 'orders.write',
  input: UpdateOrderContactSchema,
  handler: async (data, ctx) => {
    await assertOrdersEnabled();
    const current = await getOrderById(data.id);
    if (!current) {
      throw new OrderError('not_found', 'Заказ не найден.');
    }
    const order = current.order;
    if (CONTACT_LOCKED_STATUSES.has(order.status)) {
      throw new OrderError(
        'conflict',
        'Заказ закрыт (отменён или возвращён) — контакты больше не редактируются.',
      );
    }

    // undefined = «поле не прислали» → оставляем как было; пустая строка = очистить.
    const nextCity = data.deliveryCity === undefined ? order.deliveryCity : data.deliveryCity || null;
    const nextAddress =
      data.deliveryAddress === undefined ? order.deliveryAddress : data.deliveryAddress || null;

    if (order.deliveryType === 'courier' && !nextAddress) {
      throw new OrderError(
        'invalid_address',
        'Для курьерской доставки нужен адрес — без него отправление не создать.',
      );
    }

    const comment = data.reason
      ? `Правка контактов: ${data.reason}`
      : 'Правка контактов заказа.';

    await sql.begin(async (tx: TransactionSql) => {
      // GUARDED UPDATE: заказ мог закрыться (отмена/возврат) между чтением и
      // записью — тогда правка не применяется вовсе, а не «дописывается поверх
      // истории». 0 строк → конфликт и ROLLBACK вместе с записью в ленту.
      const updated = await tx<{ id: string }[]>`
        UPDATE orders
           SET customer_name  = ${data.customerName},
               customer_email = ${data.customerEmail},
               customer_phone = ${data.customerPhone},
               delivery_city    = ${nextCity},
               delivery_address = ${nextAddress},
               updated_at = now()
         WHERE id = ${data.id}
           AND status NOT IN ('cancelled', 'refunded')
        RETURNING id
      `;
      if (updated.length !== 1) {
        throw new OrderError(
          'conflict',
          'Заказ закрыт параллельно (отменён или возвращён) — правка не применена.',
        );
      }
      // Лента заказа — то, что смотрит оператор. Без записи здесь правка была бы
      // видна только в общем журнале аудита, куда в карточке заказа не ходят.
      await tx`
        INSERT INTO order_status_history
          (order_id, kind, from_status, to_status, actor_user_id, comment)
        VALUES
          (${data.id}, 'order', ${order.status}, ${order.status}, ${ctx.user.id}, ${comment})
      `;
    });

    const after = await getOrderById(data.id);
    if (!after) {
      throw new OrderError('not_found', 'Заказ не найден после обновления.');
    }

    return {
      result: {
        order: after.order,
        /** Телефон непригоден для накладной СДЭК — UI покажет предупреждение. */
        phoneUsableForCdek: isRussianPhone(data.customerPhone),
        /**
         * Накладная уже создана: правка в нашей БД её НЕ меняет — данные нужно
         * поправить и на стороне СДЭК (или отменить и создать отправление заново).
         */
        cdekShipmentExists: Boolean(order.cdekUuid),
      },
      revalidate: [ORDERS_LIST_PATH, orderPath(data.id)],
      audit: {
        action: 'order.contact.update',
        entityType: 'order',
        entityId: data.id,
        before: {
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone,
          deliveryCity: order.deliveryCity,
          deliveryAddress: order.deliveryAddress,
        },
        after: {
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: data.customerPhone,
          deliveryCity: nextCity,
          deliveryAddress: nextAddress,
          reason: data.reason ?? null,
        },
      },
    };
  },
});

// =============================================================================
// ПРОМОКОДЫ — CRUD (orders.write), аудит 'promo.*', §4.1.
// =============================================================================

/** promo_codes row → PromoCode (минимальный маппер для RETURNING). */
function mapPromoRow(row: Record<string, unknown>): PromoCode {
  return {
    id: String(row.id),
    code: String(row.code),
    kind: row.kind as PromoCode['kind'],
    value: String(row.value),
    minOrderTotal: String(row.min_order_total),
    maxDiscount: row.max_discount === null || row.max_discount === undefined ? null : String(row.max_discount),
    usageLimit: row.usage_limit === null || row.usage_limit === undefined ? null : Number(row.usage_limit),
    perCustomerLimit:
      row.per_customer_limit === null || row.per_customer_limit === undefined
        ? null
        : Number(row.per_customer_limit),
    usedCount: Number(row.used_count),
    startsAt: row.starts_at ? new Date(row.starts_at as string) : null,
    endsAt: row.ends_at ? new Date(row.ends_at as string) : null,
    isActive: Boolean(row.is_active),
    bogoBuyQty: row.bogo_buy_qty === null || row.bogo_buy_qty === undefined ? null : Number(row.bogo_buy_qty),
    bogoPayQty: row.bogo_pay_qty === null || row.bogo_pay_qty === undefined ? null : Number(row.bogo_pay_qty),
    applyScope: (row.apply_scope as PromoCode['applyScope']) ?? 'cart',
    priority: row.priority === null || row.priority === undefined ? 100 : Number(row.priority),
    stackable: Boolean(row.stackable),
    minQty: row.min_qty === null || row.min_qty === undefined ? null : Number(row.min_qty),
    giftProductId:
      row.gift_product_id === null || row.gift_product_id === undefined ? null : String(row.gift_product_id),
    giftVariantId:
      row.gift_variant_id === null || row.gift_variant_id === undefined ? null : String(row.gift_variant_id),
    giftQty: row.gift_qty === null || row.gift_qty === undefined ? null : Number(row.gift_qty),
    comment: String(row.comment ?? ''),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Bulk-вставка таргетов акции в транзакции (DELETE-then-INSERT вызывается отдельно
 * при update). Ровно одно *_id заполнено согласно targetType (Zod уже проверил,
 * CHECK в БД дублирует инвариант). Пустой массив → ничего не вставляем.
 */
async function insertPromoTargets(
  tx: TransactionSql,
  promoCodeId: string,
  targets: ReadonlyArray<{
    targetType: 'category' | 'brand' | 'product' | 'variant';
    categoryId?: string;
    brandId?: string;
    productId?: string;
    variantId?: string;
  }>,
): Promise<void> {
  for (const t of targets) {
    await tx`
      INSERT INTO promo_targets (
        promo_code_id, target_type, category_id, brand_id, product_id, variant_id
      ) VALUES (
        ${promoCodeId}, ${t.targetType}, ${t.categoryId ?? null}, ${t.brandId ?? null},
        ${t.productId ?? null}, ${t.variantId ?? null}
      )
      ON CONFLICT DO NOTHING
    `;
  }
}

export const createPromoCode = defineAction({
  permission: 'orders.write',
  input: PromoCreateSchema,
  handler: async (data, _ctx) => {
    await assertOrdersEnabled();
    let rows: Record<string, unknown>[];
    try {
      rows = await sql.begin(async (tx: TransactionSql) => {
        const inserted = await tx<Record<string, unknown>[]>`
          INSERT INTO promo_codes (
            code, kind, value, min_order_total, max_discount, usage_limit,
            per_customer_limit, starts_at, ends_at, is_active,
            bogo_buy_qty, bogo_pay_qty, apply_scope, priority, stackable, min_qty,
            gift_product_id, gift_variant_id, gift_qty, comment
          ) VALUES (
            ${data.code}, ${data.kind}, ${data.value}, ${data.minOrderTotal},
            ${data.maxDiscount ?? null}, ${data.usageLimit ?? null},
            ${data.perCustomerLimit ?? null}, ${data.startsAt ?? null},
            ${data.endsAt ?? null}, ${data.isActive}, ${data.bogoBuyQty ?? null},
            ${data.bogoPayQty ?? null}, ${data.applyScope}, ${data.priority},
            ${data.stackable}, ${data.minQty ?? null}, ${data.giftProductId ?? null},
            ${data.giftVariantId ?? null}, ${data.giftQty ?? null}, ${data.comment}
          )
          RETURNING *
        `;
        await insertPromoTargets(tx, String(inserted[0]!.id), data.targets);
        return inserted;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new OrderError('duplicate_code', 'Промокод с таким кодом уже существует.');
      }
      throw err;
    }
    const promo = mapPromoRow(rows[0]!);
    return {
      result: promo,
      revalidate: [PROMO_LIST_PATH],
      audit: {
        action: 'promo.create',
        entityType: 'promo_code',
        entityId: promo.id,
        after: {
          code: promo.code,
          kind: promo.kind,
          value: promo.value,
          applyScope: promo.applyScope,
          targets: data.targets.length,
        },
      },
    };
  },
});

export const updatePromoCode = defineAction({
  permission: 'orders.write',
  input: PromoUpdateSchema,
  handler: async (data, _ctx) => {
    await assertOrdersEnabled();
    const before = await sql<Record<string, unknown>[]>`
      SELECT * FROM promo_codes WHERE id = ${data.id} LIMIT 1
    `;
    if (!before[0]) {
      throw new OrderError('not_found', 'Промокод не найден.');
    }
    // Баг #3 (data-integrity): refinePromo проверяет percent 0..100 ТОЛЬКО когда в
    // payload есть и kind, и value. При частичном апдейте ({id, value:'150'} без
    // kind, в БД kind='percent') проверка обходилась → скидка >100% попадала в БД.
    // Считаем ЭФФЕКТИВНЫЕ kind/value (из запроса или текущие из БД) и валидируем ту
    // же границу, что refinePromo (percent: value ≤ 100; нижняя граница уже на Zod —
    // moneySchema запрещает минус). Делаем это ДО UPDATE, чтобы запись не выполнялась.
    const effectiveKind = (data.kind ?? before[0].kind) as string;
    const effectiveValue = data.value ?? (before[0].value as string | null | undefined);
    if (effectiveKind === 'percent' && effectiveValue != null) {
      const pct = Number(effectiveValue);
      if (Number.isNaN(pct) || pct > 100) {
        throw new OrderError(
          'validation',
          'Для percent value должно быть в диапазоне 0..100.',
        );
      }
    }
    // Управляем таргетами ТОЛЬКО когда они реально затрагиваются запросом
    // (баг #18): scope передан явно (в т.ч. 'cart' — тогда чистим) ИЛИ передан
    // массив targets. При partial-update БЕЗ упоминания scope/targets — таргеты
    // не трогаем (сохраняем существующие). Раньше applyScope получал default
    // 'cart' даже при опущенном ключе → manageTargets всегда true → DELETE стирал
    // promo_targets категорийного/брендового промокода. Теперь applyScope/targets
    // приходят undefined, если ключ не передан (см. promoUpdateShape).
    const manageTargets = data.applyScope !== undefined || data.targets !== undefined;
    const targetsToWrite = data.targets ?? [];

    // Инвариант refinePromo: scope category/brand/set требует ≥1 цели. При
    // частичном апдейте scope может быть опущен — берём ЭФФЕКТИВНЫЙ (из запроса
    // или текущий из БД). Если очищаем/оставляем targets пустыми у scoped-
    // промокода — отказ: иначе apply_scope рассинхронизировался бы с promo_targets
    // (scoped-промокод без целей — «мёртвый», даёт 0 скидки). refinePromo это не
    // ловит, т.к. при опущенном applyScope не знает текущий scope строки.
    if (manageTargets && targetsToWrite.length === 0) {
      const effectiveScope = (data.applyScope ?? before[0].apply_scope) as string;
      if (effectiveScope === 'category' || effectiveScope === 'brand' || effectiveScope === 'set') {
        throw new OrderError(
          'scope_requires_targets',
          `Для акции с областью «${effectiveScope}» нужна хотя бы одна цель. ` +
            'Укажите цели (targets) или смените область на «вся корзина» (cart).',
        );
      }
    }

    let after: Record<string, unknown>[];
    try {
      after = await sql.begin(async (tx: TransactionSql) => {
        const updated = await tx<Record<string, unknown>[]>`
          UPDATE promo_codes SET
            code            = COALESCE(${data.code ?? null}, code),
            kind            = COALESCE(${data.kind ?? null}, kind),
            value           = COALESCE(${data.value ?? null}, value),
            min_order_total = COALESCE(${data.minOrderTotal ?? null}, min_order_total),
            max_discount    = CASE WHEN ${data.maxDiscount !== undefined}
                                   THEN ${data.maxDiscount ?? null} ELSE max_discount END,
            usage_limit     = CASE WHEN ${data.usageLimit !== undefined}
                                   THEN ${data.usageLimit ?? null} ELSE usage_limit END,
            per_customer_limit = CASE WHEN ${data.perCustomerLimit !== undefined}
                                   THEN ${data.perCustomerLimit ?? null} ELSE per_customer_limit END,
            starts_at       = CASE WHEN ${data.startsAt !== undefined}
                                   THEN ${data.startsAt ?? null} ELSE starts_at END,
            ends_at         = CASE WHEN ${data.endsAt !== undefined}
                                   THEN ${data.endsAt ?? null} ELSE ends_at END,
            is_active       = COALESCE(${data.isActive ?? null}, is_active),
            bogo_buy_qty    = CASE WHEN ${data.bogoBuyQty !== undefined}
                                   THEN ${data.bogoBuyQty ?? null} ELSE bogo_buy_qty END,
            bogo_pay_qty    = CASE WHEN ${data.bogoPayQty !== undefined}
                                   THEN ${data.bogoPayQty ?? null} ELSE bogo_pay_qty END,
            apply_scope     = COALESCE(${data.applyScope ?? null}, apply_scope),
            priority        = COALESCE(${data.priority ?? null}, priority),
            stackable       = COALESCE(${data.stackable ?? null}, stackable),
            min_qty         = CASE WHEN ${data.minQty !== undefined}
                                   THEN ${data.minQty ?? null} ELSE min_qty END,
            gift_product_id = CASE WHEN ${data.giftProductId !== undefined}
                                   THEN ${data.giftProductId ?? null} ELSE gift_product_id END,
            gift_variant_id = CASE WHEN ${data.giftVariantId !== undefined}
                                   THEN ${data.giftVariantId ?? null} ELSE gift_variant_id END,
            gift_qty        = CASE WHEN ${data.giftQty !== undefined}
                                   THEN ${data.giftQty ?? null} ELSE gift_qty END,
            comment         = COALESCE(${data.comment ?? null}, comment),
            updated_at      = now()
          WHERE id = ${data.id}
          RETURNING *
        `;
        if (manageTargets) {
          await tx`DELETE FROM promo_targets WHERE promo_code_id = ${data.id}`;
          await insertPromoTargets(tx, data.id, targetsToWrite);
        }
        return updated;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new OrderError('duplicate_code', 'Промокод с таким кодом уже существует.');
      }
      throw err;
    }
    const promo = mapPromoRow(after[0]!);
    return {
      result: promo,
      revalidate: [PROMO_LIST_PATH],
      audit: {
        action: 'promo.update',
        entityType: 'promo_code',
        entityId: data.id,
        before: before[0],
        after: after[0],
      },
    };
  },
});

/**
 * Деактивация промокода (мягкое «удаление»): is_active=false. История заказов не
 * рушится (snapshot promo_code + ON DELETE SET NULL); код остаётся для отчётов.
 */
export const deactivatePromoCode = defineAction({
  permission: 'orders.write',
  input: PromoIdSchema,
  handler: async (data, _ctx) => {
    await assertOrdersEnabled();
    const rows = await sql<{ id: string }[]>`
      UPDATE promo_codes SET is_active = false, updated_at = now()
      WHERE id = ${data.id}
      RETURNING id
    `;
    if (!rows[0]) {
      throw new OrderError('not_found', 'Промокод не найден.');
    }
    return {
      result: { id: data.id },
      revalidate: [PROMO_LIST_PATH],
      audit: {
        action: 'promo.deactivate',
        entityType: 'promo_code',
        entityId: data.id,
        after: { isActive: false },
      },
    };
  },
});

/**
 * Полное удаление промокода (DELETE). История заказов не рушится: orders.promo_code
 * (снимок) сохраняется, promo_code_id → NULL (ON DELETE SET NULL, §2.1).
 */
export const deletePromoCode = defineAction({
  permission: 'orders.write',
  input: PromoIdSchema,
  handler: async (data, _ctx) => {
    await assertOrdersEnabled();
    const rows = await sql<{ id: string }[]>`
      DELETE FROM promo_codes WHERE id = ${data.id} RETURNING id
    `;
    if (!rows[0]) {
      throw new OrderError('not_found', 'Промокод не найден.');
    }
    return {
      result: { id: data.id },
      revalidate: [PROMO_LIST_PATH],
      audit: {
        action: 'promo.delete',
        entityType: 'promo_code',
        entityId: data.id,
      },
    };
  },
});