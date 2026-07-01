/**
 * Cron-сверка платежей Т-Банка (Фича #16, порт lib/cdek/cron.ts).
 *
 * Проблема: потерянный/непришедший webhook оставляет РЕАЛЬНО оплаченный заказ в
 * payment_status='pending'/'authorized'. Этот воркер по «зависшим» tbank-заказам
 * дёргает GetState (PaymentService.reconcilePayment) и ИДЕМПОТЕНТНО доводит статус.
 *
 * Реализован как ЧИСТАЯ, ТЕСТИРУЕМАЯ логика с инъекцией deps (поиск кандидатов +
 * сверка). По умолчанию deps — реальные (sql + PaymentService), в тестах
 * подменяются моками (без живой БД/сети, ADR-004).
 *
 * Гарантии:
 *   • идемпотентность — recordWebhookEvent (UNIQUE (payment_id, status)) не задваивает,
 *     гард C4-1 не пометит paid отменённый/возвращённый заказ;
 *   • устойчивость — ошибка по одному заказу не валит прогон (failed++);
 *   • анти-гонка — весь прогон под транзакционным advisory-lock (как create-pending СДЭК):
 *     перекрывшийся/двойной тик → lockSkipped, без повторной обработки.
 *
 * Локальная копия withAdvisoryLock (не импорт из lib/cdek/cron) — payments не должен
 * зависеть от cdek (модули включаются/выключаются независимо, мультитенантность).
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import { toKopecks } from './receipt';
import { PaymentService } from './service';

/** Лимит заказов на один прогон сверки. */
export const RECONCILE_PENDING_LIMIT = 100;

/** Стабильный ключ advisory-lock для сериализации прогонов сверки. */
const RECONCILE_LOCK_KEY = 'tbank:reconcile-pending';

/** Кандидат на сверку: «зависший» оплачиваемый tbank-заказ. */
export interface PendingPaymentCandidate {
  id: string;
  number: string;
  /** PaymentId Т-Банка (orders.payment_ref) — обязателен (фильтр IS NOT NULL). */
  paymentRef: string;
  /** Сумма заказа в КОПЕЙКАХ (из grand_total, считает воркер) — для аудит-лога. */
  amountKop: number | null;
}

/** Статистика прогона сверки. */
export interface ReconcileStats {
  /** Сколько кандидатов реально опрошено (GetState вернул ok). */
  checked: number;
  /** По скольким переход payment_status применён в этой сверке. */
  advanced: number;
  /** Сколько упало (исключение по одному заказу). */
  failed: number;
  /** Прогон пропущен: advisory-lock держит параллельный прогон (no-op). */
  lockSkipped?: boolean;
}

/**
 * Результат попытки взять advisory-lock и выполнить критическую секцию.
 * acquired=false → секция НЕ выполнялась (лок занят другим процессом).
 */
export type WithLockResult<T> = { acquired: true; result: T } | { acquired: false };

/** Сериализатор прогона: берёт advisory-lock по ключу и выполняет fn под ним. */
export type WithLock = <T>(key: string, fn: () => Promise<T>) => Promise<WithLockResult<T>>;

/**
 * Дефолтная реализация withLock через sql.begin + pg_try_advisory_xact_lock.
 * hashtext(key) → int4-ключ для advisory-lock (детерминированный на ключ). Лок
 * держится до конца транзакции (xact-lock) — критическая секция гарантированно одна.
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
 * «Зависшие» оплачиваемые tbank-заказы для сверки GetState:
 *   payment_provider='tbank', payment_status ∈ (pending, authorized), есть payment_ref,
 *   заказ не отменён/возвращён, создан за последние 3 дня (не дёргать вечно зависшие).
 * Сумма берётся из grand_total и переводится в копейки воркером (toKopecks, как в
 * service.initPayment) — единая точка денежной арифметики. ORDER BY created_at LIMIT.
 */
export async function findPendingTbankPayments(
  limit: number = RECONCILE_PENDING_LIMIT,
): Promise<PendingPaymentCandidate[]> {
  const rows = await sql<
    Array<{ id: string; number: string; payment_ref: string; grand_total: string }>
  >`
    SELECT o.id, o.number, o.payment_ref, o.grand_total
      FROM orders o
     WHERE o.payment_provider = 'tbank'
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
    paymentRef: String(r.payment_ref),
    amountKop: toKopecks(String(r.grand_total)),
  }));
}

/** Инъецируемые зависимости воркера сверки (для тестов). */
export interface ReconcileDeps {
  /** Сериализатор прогона (advisory-lock). По умолчанию — withAdvisoryLock. */
  withLock: WithLock;
  /** Поиск кандидатов. По умолчанию — findPendingTbankPayments. */
  findCandidates: (limit?: number) => Promise<PendingPaymentCandidate[]>;
  /** Сверка одного кандидата (GetState + доведение статуса). */
  reconcile: (c: PendingPaymentCandidate) => Promise<{ applied: boolean; ok: boolean }>;
}

function defaultReconcileDeps(): ReconcileDeps {
  return {
    withLock: withAdvisoryLock,
    findCandidates: findPendingTbankPayments,
    reconcile: (c) =>
      new PaymentService()
        .reconcilePayment({
          orderId: c.id,
          orderNumber: c.number,
          paymentId: c.paymentRef,
          amountKop: c.amountKop ?? undefined,
        })
        .then((r) => ({ applied: r.applied, ok: r.ok })),
  };
}

/**
 * reconcile-pending (каждые 15 мин): по «зависшим» tbank-заказам дёргает GetState и
 * доводит статус. Идемпотентно (recordWebhookEvent), устойчиво (ошибка одного заказа
 * → failed++, прогон продолжается), сериализовано advisory-lock (lockSkipped при
 * перекрытии — без повторной обработки кандидатов).
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
    // Параллельный/перекрывшийся прогон уже держит лок — этот прогон — no-op.
    return { checked: 0, advanced: 0, failed: 0, lockSkipped: true };
  }
  return locked.result;
}
