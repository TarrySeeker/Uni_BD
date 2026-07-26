/**
 * УБОРЩИК БРОШЕННЫХ НЕОПЛАЧЕННЫХ ЗАКАЗОВ (аудит 2026-07-26: критичное №4, major №13).
 *
 * ЧТО БЫЛО СЛОМАНО
 * ----------------
 * Заказ рождается со списанным балансом подарочного сертификата (redeemGiftTx стоит
 * в ТОЙ ЖЕ транзакции, что INSERT заказа — lib/orders/repository.ts) и с ЗАНЯТЫМ
 * резервом склада, но с payment_status='pending'. Если покупатель не заплатил,
 * заказ так и остаётся 'new'/'awaiting_payment' навсегда:
 *   • сертификат на 5000 ₽ «сгорел»: держатель кода видит нулевой остаток, а заказа
 *     фактически нет (releaseGiftTx вызывается ТОЛЬКО при cancelled/refunded);
 *   • резерв склада заблокирован: товар пропал из продажи для всех остальных;
 *   • применение промокода (used_count / promo_redemptions) съедено.
 * Ни витрина, ни крон-сверка, ни статус-машина этого не разбирали — задачи уборки
 * в проекте не существовало.
 *
 * ПОЧЕМУ ТОЧКА ВОЗВРАТА — ОТМЕНА ЗАКАЗА, А НЕ payment_status='failed'
 * ------------------------------------------------------------------
 * Соблазнительно вернуть баланс там, где оплата провалилась (expired/cancelled →
 * 'failed'). Это НЕВЕРНО и стоило бы денег магазину: 'failed' в
 * PAYMENT_STATUS_TRANSITIONS НЕ терминален (failed → pending/authorized/paid) —
 * покупатель законно повторяет оплату из ЛК, и витрина это поддерживает
 * (isOrderPayable допускает failed). Вернув баланс на 'failed', мы оставили бы
 * ЖИВОЙ заказ с уже уменьшенным на номинал grand_total и одновременно полный
 * сертификат: повторная оплата дала бы покупателю скидку дважды.
 *
 * Единственный момент, когда «заказ окончательно не состоялся», — это его ОТМЕНА.
 * Поэтому уборщик не изобретает новую денежную операцию, а доводит брошенный заказ
 * до 'cancelled' тем же сетлом, что и ручная отмена оператором
 * (settleOrderClosureTx): резерв → назад, промокод → откат, БАЛАНС СЕРТИФИКАТА →
 * держателю, выпущенные по заказу коды → погашены. Одна точка закрывает и №4
 * (деньги покупателя), и №13 (резерв склада).
 *
 * ГОНКА С ПОЗДНЕЙ ОПЛАТОЙ
 * -----------------------
 * Сценарий: воркер выбрал кандидата → в этот момент приходит вебхук об оплате.
 *   • ДО отмены: гард `expireUnpaidOrderTx` ПЕРЕЧИТЫВАЕТ строку заказа FOR UPDATE и
 *     повторно проверяет ВСЕ условия (статус, payment_status, paid_at, порог).
 *     Вебхук берёт ту же блокировку строки (SELECT ... FOR UPDATE в
 *     applyPaymentStatusTx), поэтому две транзакции сериализуются: кто второй —
 *     видит актуальные данные. Оплаченный заказ не отменяется никогда.
 *   • ПОСЛЕ отмены: гард C4-1 в applyPaymentStatusTx (все три эквайера) НЕ
 *     применяет paid/authorized к отменённому заказу — «протухший» заказ не
 *     оживает, повторного списания баланса не происходит (redeemGiftTx выполняется
 *     ровно один раз, при создании заказа, и второй раз не вызывается ниоткуда), а
 *     оператор получает warn для ручной сверки/возврата.
 * Отсюда же требование к настройке: TTL обязан быть БОЛЬШЕ времени жизни ссылки
 * оплаты (TBANK_REDIRECT_DUE_MIN и аналоги), иначе уборщик будет отменять заказы,
 * которые покупатель ещё оплачивает.
 *
 * КОГО НЕ ТРОГАЕМ (мультитенантность, без хардкода под магазин)
 * ------------------------------------------------------------
 * Отменяются только заказы ПРЕДОПЛАТНЫХ способов (card/sbp) из витрины: для
 * наложенного платежа (cod), счёта (invoice), оплаты в СДЭК (cdek_pay) и
 * неуказанного способа (unset) «неоплаченность» — нормальное состояние на дни и
 * недели, а ручные заказы оператора (source='admin') живут по своим правилам.
 * Сам уборщик включается сроком ORDERS_UNPAID_TTL_MINUTES (0 = выключен).
 */

import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db/client';
import { getEnv } from '@/lib/config/env';
import { logger as appLogger, type Logger } from '@/lib/logger';

import { settleOrderClosureTx } from './refund-settle';
import type { OrderStatus, PaymentMethod, PaymentStatus } from './types';

// -----------------------------------------------------------------------------
// Критерии кандидата (данные, а не «магия в SQL»).
// -----------------------------------------------------------------------------

/**
 * Статусы заказа, из которых авто-отмена допустима: резерв ещё держится, заказ не
 * в работе. 'paid'/'packed' сюда НЕ входят — там заказом уже занимается человек.
 */
export const EXPIRABLE_ORDER_STATUSES: readonly OrderStatus[] = ['new', 'awaiting_payment'];

/** Статусы оплаты, при которых денег НЕТ (и не было): pending/failed. */
export const EXPIRABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = ['pending', 'failed'];

/**
 * Способы оплаты, подразумевающие ПРЕДОПЛАТУ онлайн: только их брошенность —
 * аномалия. Магазин с другим набором предоплатных способов расширяет список здесь
 * (значения — из PAYMENT_METHODS, lib/orders/types.ts).
 */
export const AUTO_EXPIRE_PAYMENT_METHODS: readonly PaymentMethod[] = ['card', 'sbp'];

/** Источник заказа, подлежащий авто-отмене (ручные заказы оператора не трогаем). */
export const AUTO_EXPIRE_SOURCE = 'storefront';

/** Лимит заказов на один прогон. */
export const EXPIRE_UNPAID_LIMIT = 200;

/** Стабильный ключ advisory-lock для сериализации прогонов. */
export const EXPIRE_UNPAID_LOCK_KEY = 'orders:expire-unpaid';

// -----------------------------------------------------------------------------
// Чистая часть.
// -----------------------------------------------------------------------------

/** Включена ли авто-отмена (ttl > 0). Нечисловое/отрицательное → выключено (fail-safe). */
export function isAutoExpireEnabled(ttlMinutes: number): boolean {
  return Number.isFinite(ttlMinutes) && ttlMinutes > 0;
}

/** Порог «просроченности»: заказы, созданные РАНЬШЕ него, — кандидаты. */
export function expireCutoff(nowMs: number, ttlMinutes: number): Date {
  return new Date(nowMs - ttlMinutes * 60_000);
}

/** TTL из конфигурации инстанса (минуты; 0 = выключено). */
export function configuredUnpaidTtlMinutes(): number {
  return getEnv().ORDERS_UNPAID_TTL_MINUTES;
}

// -----------------------------------------------------------------------------
// БД-часть.
// -----------------------------------------------------------------------------

/** Кандидат на авто-отмену. */
export interface ExpiredOrderCandidate {
  id: string;
  number: string;
}

/**
 * Просроченные брошенные заказы. Выборка НЕ помечает кандидатов (пометка была бы
 * ещё одним состоянием в схеме): защита от двойной обработки — advisory-lock на
 * прогон + гард под FOR UPDATE в expireUnpaidOrderTx.
 */
export async function findExpiredUnpaidOrders(
  cutoff: Date,
  limit: number = EXPIRE_UNPAID_LIMIT,
): Promise<ExpiredOrderCandidate[]> {
  const rows = await sql<Array<{ id: string; number: string }>>`
    SELECT id, number
      FROM orders
     WHERE status = ANY(${[...EXPIRABLE_ORDER_STATUSES]}::text[])
       AND payment_status = ANY(${[...EXPIRABLE_PAYMENT_STATUSES]}::text[])
       AND paid_at IS NULL
       AND payment_method = ANY(${[...AUTO_EXPIRE_PAYMENT_METHODS]}::text[])
       AND source = ${AUTO_EXPIRE_SOURCE}
       AND created_at < ${cutoff}
     ORDER BY created_at
     LIMIT ${limit}
  `;
  return rows.map((r) => ({ id: String(r.id), number: String(r.number) }));
}

/** Результат обработки одного заказа. */
export type ExpireOutcome = 'cancelled' | 'skipped';

/**
 * АТОМАРНАЯ отмена одного просроченного заказа на переданной транзакции.
 *
 * Шаг 1 — ГАРД: строка заказа перечитывается FOR UPDATE и ВСЕ условия кандидата
 * проверяются заново (статус/оплата/paid_at/способ/источник/порог). Это и есть
 * защита от гонки с поздней оплатой: конкурентный вебхук держит ту же блокировку,
 * поэтому мы либо увидим уже оплаченный заказ и уйдём в 'skipped', либо отменим
 * заказ до того, как вебхук успеет что-то применить (а после отмены его остановит
 * гард C4-1). Идемпотентность: повторный вызов по уже отменённому заказу не
 * проходит гард → баланс сертификата не возвращается второй раз.
 *
 * Шаг 2 — СЕТЛ: тот же путь, что у ручной отмены оператором.
 */
export async function expireUnpaidOrderTx(
  tx: TransactionSql,
  orderId: string,
  cutoff: Date,
): Promise<ExpireOutcome> {
  const rows = await tx<
    Array<{
      status: string;
      payment_status: string;
      paid_at: Date | null;
      payment_method: string;
      source: string;
      expired: boolean;
    }>
  >`
    SELECT status, payment_status, paid_at, payment_method, source,
           (created_at < ${cutoff}) AS expired
      FROM orders
     WHERE id = ${orderId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return 'skipped';

  const stillExpirable =
    row.expired === true &&
    row.paid_at === null &&
    (EXPIRABLE_ORDER_STATUSES as readonly string[]).includes(row.status) &&
    (EXPIRABLE_PAYMENT_STATUSES as readonly string[]).includes(row.payment_status) &&
    (AUTO_EXPIRE_PAYMENT_METHODS as readonly string[]).includes(row.payment_method) &&
    row.source === AUTO_EXPIRE_SOURCE;

  if (!stillExpirable) return 'skipped';

  await settleOrderClosureTx(tx, orderId, {
    to: 'cancelled',
    actorUserId: null, // система
    comment: 'Автоматическая отмена: заказ не оплачен в отведённый срок.',
  });
  return 'cancelled';
}

/** Обёртка с собственной транзакцией (прод-путь воркера). */
export async function expireUnpaidOrder(orderId: string, cutoff: Date): Promise<ExpireOutcome> {
  return await sql.begin<ExpireOutcome>((tx: TransactionSql) =>
    expireUnpaidOrderTx(tx, orderId, cutoff),
  );
}

// -----------------------------------------------------------------------------
// Воркер прогона (advisory-lock, инъекция зависимостей — юниты без БД).
// -----------------------------------------------------------------------------

/** Результат попытки взять advisory-lock: acquired=false → секция не выполнялась. */
export type WithLockResult<T> = { acquired: true; result: T } | { acquired: false };

export type WithLock = <T>(key: string, fn: () => Promise<T>) => Promise<WithLockResult<T>>;

/**
 * Дефолтный сериализатор: транзакционный advisory-lock. Держится до конца
 * транзакции, поэтому перекрывшийся тик (или второй инстанс приложения) не
 * обрабатывает тех же кандидатов повторно.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<WithLockResult<T>> {
  return await sql.begin<WithLockResult<T>>(async (tx: TransactionSql) => {
    const rows = await tx<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked
    `;
    if (rows[0]?.locked !== true) return { acquired: false };
    return { acquired: true, result: await fn() };
  });
}

/** Статистика прогона. */
export interface ExpireUnpaidStats {
  /** false → хотя бы один заказ не обработан (роут отдаёт не-2xx). */
  ok: boolean;
  scanned: number;
  cancelled: number;
  /** Кандидат не прошёл гард (успел оплатиться/уехать по статусу) — это норма. */
  skipped: number;
  failed: number;
  /** Прогон пропущен: параллельный тик держит лок. */
  lockSkipped: boolean;
  /** Авто-отмена выключена настройкой (ttl = 0). */
  disabled: boolean;
}

/** Инъецируемые зависимости (для юнитов без БД). */
export interface ExpireUnpaidDeps {
  ttlMinutes: number;
  now: () => number;
  withLock: WithLock;
  findCandidates: (cutoff: Date, limit?: number) => Promise<ExpiredOrderCandidate[]>;
  expireOne: (orderId: string, cutoff: Date) => Promise<ExpireOutcome>;
  logger: Logger;
}

export function productionExpireUnpaidDeps(): ExpireUnpaidDeps {
  return {
    ttlMinutes: configuredUnpaidTtlMinutes(),
    now: () => Date.now(),
    withLock: withAdvisoryLock,
    findCandidates: findExpiredUnpaidOrders,
    expireOne: expireUnpaidOrder,
    logger: appLogger.child({ module: 'orders-expire' }),
  };
}

/**
 * expire-unpaid: отменяет просроченные неоплаченные заказы витрины, возвращая
 * покупателю баланс сертификата, а магазину — резерв склада и лимит промокода.
 *
 * Устойчивость: ошибка по одному заказу не валит прогон (failed++). Честный итог:
 * ok=false, если хоть один заказ не доехал, — иначе провал выглядит успехом в
 * логах cron-контейнера.
 */
export async function runExpireUnpaid(
  deps: ExpireUnpaidDeps = productionExpireUnpaidDeps(),
): Promise<ExpireUnpaidStats> {
  const empty: ExpireUnpaidStats = {
    ok: true,
    scanned: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
    lockSkipped: false,
    disabled: false,
  };

  if (!isAutoExpireEnabled(deps.ttlMinutes)) {
    return { ...empty, disabled: true };
  }

  const cutoff = expireCutoff(deps.now(), deps.ttlMinutes);

  const locked = await deps.withLock(EXPIRE_UNPAID_LOCK_KEY, async () => {
    const stats: ExpireUnpaidStats = { ...empty };
    const candidates = await deps.findCandidates(cutoff, EXPIRE_UNPAID_LIMIT);
    stats.scanned = candidates.length;

    for (const cand of candidates) {
      try {
        const outcome = await deps.expireOne(cand.id, cutoff);
        if (outcome === 'cancelled') stats.cancelled += 1;
        else stats.skipped += 1;
      } catch (err) {
        stats.failed += 1;
        deps.logger.error('авто-отмена: заказ не обработан', {
          orderId: cand.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    stats.ok = stats.failed === 0;
    if (stats.cancelled > 0 || stats.failed > 0) {
      deps.logger.info('авто-отмена просроченных заказов завершена', {
        scanned: stats.scanned,
        cancelled: stats.cancelled,
        skipped: stats.skipped,
        failed: stats.failed,
      });
    }
    return stats;
  });

  if (!locked.acquired) return { ...empty, lockSkipped: true };
  return locked.result;
}
