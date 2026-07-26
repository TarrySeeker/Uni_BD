/**
 * Cron-сверка платежей Альфа-Банка (порт paykeeper/cron.ts на REST-модель RBS).
 *
 * Проблема: потерянный колбэк оставляет реально оплаченный заказ в
 * payment_status='pending'. Этот воркер по «зависшим» alfabank-заказам дёргает
 * getOrderStatusExtended (PaymentService.reconcilePayment) и ИДЕМПОТЕНТНО доводит
 * статус.
 *
 * Чистая, тестируемая логика с инъекцией deps. По умолчанию deps — реальные (sql +
 * PaymentService), в тестах подменяются моками.
 *
 * Гарантии: идемпотентность (recordWebhookEvent, UNIQUE (order_ref, status)),
 * устойчивость (ошибка одного заказа → failed++), анти-гонка (advisory-lock).
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import { toMinor } from '@/lib/orders/money';
import { PaymentService } from './service';

/** Лимит заказов на один прогон сверки. */
export const RECONCILE_PENDING_LIMIT = 100;

/** Стабильный ключ advisory-lock для сериализации прогонов сверки. */
const RECONCILE_LOCK_KEY = 'alfabank:reconcile-pending';

/** Кандидат на сверку: «зависший» оплачиваемый alfabank-заказ. */
export interface PendingPaymentCandidate {
  id: string;
  number: string;
  /** orderId Альфа-Банка (orders.payment_ref) — обязателен (фильтр IS NOT NULL). */
  paymentId: string;
  /** Сумма заказа в КОПЕЙКАХ (из grand_total) — для аудит-лога. */
  amountKop: number | null;
}

/** Статистика прогона сверки. */
export interface ReconcileStats {
  checked: number;
  advanced: number;
  failed: number;
  lockSkipped?: boolean;
}

/** Результат попытки взять advisory-lock и выполнить критическую секцию. */
export type WithLockResult<T> = { acquired: true; result: T } | { acquired: false };

/** Сериализатор прогона: берёт advisory-lock по ключу и выполняет fn под ним. */
export type WithLock = <T>(key: string, fn: () => Promise<T>) => Promise<WithLockResult<T>>;

/** Мягкий перевод рублёвой строки → копейки (не бросает). */
function toKopecksSafe(value: string | number): number {
  try {
    return toMinor(value);
  } catch {
    return 0;
  }
}

/**
 * Дефолтная реализация withLock через sql.begin + pg_try_advisory_xact_lock.
 * hashtext(key) → int4-ключ. Лок держится до конца транзакции (xact-lock).
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<WithLockResult<T>> {
  return await sql.begin<WithLockResult<T>>(async (tx: TransactionSql) => {
    const rows = await tx<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked
    `;
    if (rows[0]?.locked !== true) {
      return { acquired: false };
    }
    const result = await fn();
    return { acquired: true, result };
  });
}

/**
 * «Зависшие» оплачиваемые alfabank-заказы для сверки:
 *   payment_provider='alfabank', payment_status ∈ (pending, authorized), есть
 *   payment_ref, заказ не отменён/возвращён, создан за последние 3 дня.
 * Сумма из grand_total → копейки воркером. ORDER BY created_at LIMIT.
 *
 * 🔴 ПОЧЕМУ И `authorized` (как в tbank/cron.ts). У RBS двухстадийная оплата:
 * orderStatus=1 — деньги УДЕРЖАНЫ (холд), и такой заказ платформа больше не даёт
 * оплатить повторно (paymentBlockFor → funds_held, иначе второе списание). Значит
 * незавершённый холд обязан выводиться из этого состояния БЕЗ покупателя: сверка
 * спросит getOrderStatusExtended и доведёт статус — снятая/отклонённая
 * авторизация (orderStatus 3/6) → 'failed' (заказ снова оплачиваем), полная (2) →
 * 'paid'. Без этой строки истёкший холд запирал бы заказ до ручного вмешательства
 * оператора. Повтор того же статуса ничего не делает: canTransition отсекает
 * authorized → authorized.
 */
export async function findPendingAlfabankPayments(
  limit: number = RECONCILE_PENDING_LIMIT,
): Promise<PendingPaymentCandidate[]> {
  const rows = await sql<
    Array<{ id: string; number: string; payment_ref: string; grand_total: string }>
  >`
    SELECT o.id, o.number, o.payment_ref, o.grand_total
      FROM orders o
     WHERE o.payment_provider = 'alfabank'
       AND o.payment_status IN ('pending', 'authorized')
       AND o.payment_ref IS NOT NULL
       AND o.status NOT IN ('cancelled', 'refunded')
       AND o.created_at > now() - interval '3 days'
     ORDER BY o.created_at
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: String(r.id),
    number: String(r.number),
    paymentId: String(r.payment_ref),
    amountKop: toKopecksSafe(String(r.grand_total)),
  }));
}

/** Инъецируемые зависимости воркера сверки (для тестов). */
export interface ReconcileDeps {
  withLock: WithLock;
  findCandidates: (limit?: number) => Promise<PendingPaymentCandidate[]>;
  reconcile: (c: PendingPaymentCandidate) => Promise<{ applied: boolean; ok: boolean }>;
}

function defaultReconcileDeps(): ReconcileDeps {
  return {
    withLock: withAdvisoryLock,
    findCandidates: findPendingAlfabankPayments,
    reconcile: (c) =>
      new PaymentService()
        .reconcilePayment({
          orderId: c.id,
          orderNumber: c.number,
          paymentId: c.paymentId,
          amountKop: c.amountKop ?? undefined,
        })
        .then((r) => ({ applied: r.applied, ok: r.ok })),
  };
}

/**
 * reconcile-pending-alfabank (каждые 15 мин): по «зависшим» alfabank-заказам дёргает
 * getOrderStatusExtended и доводит статус. Идемпотентно, устойчиво, сериализовано
 * advisory-lock (lockSkipped при перекрытии).
 */
export async function runReconcilePending(
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<ReconcileStats> {
  const locked = await deps.withLock(RECONCILE_LOCK_KEY, async () => {
    const stats: ReconcileStats = { checked: 0, advanced: 0, failed: 0, lockSkipped: false };
    const candidates = await deps.findCandidates(RECONCILE_PENDING_LIMIT);
    for (const cand of candidates) {
      try {
        const r = await deps.reconcile(cand);
        stats.checked += 1;
        if (r.applied) stats.advanced += 1;
      } catch {
        stats.failed += 1;
      }
    }
    return stats;
  });

  if (!locked.acquired) {
    return { checked: 0, advanced: 0, failed: 0, lockSkipped: true };
  }
  return locked.result;
}
