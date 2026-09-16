/**
 * Крон-сверка платежей АТОЛ Pay (по образцу lib/payments/tbank/cron.ts).
 *
 * 🔴 ПОЧЕМУ ЗДЕСЬ СВЕРКА ВАЖНЕЕ, ЧЕМ У ДРУГИХ ПРОВАЙДЕРОВ.
 * У callback АТОЛа НЕТ ПОДПИСИ — ни HMAC, ни секрета уведомлений, ни
 * контрольной суммы. Поэтому во всей интеграции статус заказа меняется ТОЛЬКО
 * по ответу GET /payments/{orderId}/status, а callback — лишь сигнал «сходи
 * проверь». Следствие: если callback не дошёл (сетевой сбой, недоступность
 * сервера) ИЛИ был отвергнут роутом (не совпал секрет в query, пришёл шум),
 * единственный оставшийся способ узнать об оплате — этот воркер.
 *
 * Для Т-Банка и Озона сверка — страховка от потерянного вебхука. Здесь она
 * полноценный рабочий путь подтверждения оплаты, и её отключение означает
 * заказы, которые покупатель оплатил, а магазин навсегда считает pending.
 *
 * Гарантии (схема Т-Банка, а не Озона — у того нет ни лока, ни DI):
 *   • АНТИ-ГОНКА — весь прогон под транзакционным advisory-lock. Без него два
 *     перекрывшихся тика крона дёргают API по одним и тем же заказам
 *     параллельно: лишний расход лимитов и гонка на applyPaymentStatus;
 *   • УСТОЙЧИВОСТЬ — try/catch ВНУТРИ цикла: отказ API по одному заказу не
 *     должен лишить сверки все остальные (иначе один «битый» заказ в начале
 *     выборки блокирует подтверждение оплаты у всех, кто за ним);
 *   • ИДЕМПОТЕНТНОСТЬ — переход применяет applyPaymentStatus со статус-машиной
 *     и гардом мёртвого заказа, повторный прогон безопасен;
 *   • ТЕСТИРУЕМОСТЬ — зависимости инъецируются (ReconcileDeps), тест идёт без
 *     живой БД и сети (ADR-004).
 */

import { logger } from '@/lib/logger';
import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import type { PaymentStatus } from '@/lib/orders/types';

import { isAtolMock } from './config';
import { AtolPaymentService } from './service';
import { rublesToKopecks } from './money';
import { mapPaymentStatus, describeAtolStatus } from './status-map';
import { findPendingAtolPayments, applyPaymentStatus, type PendingAtolOrder } from './repository';

const log = logger.child({ module: 'payments/atol/cron' });

/** Сколько заказов проверяем за один прогон — чтобы не упереться в лимиты API. */
export const RECONCILE_PENDING_LIMIT = 50;

/** Стабильный ключ advisory-lock для сериализации прогонов сверки. */
export const RECONCILE_LOCK_KEY = 'atol:reconcile-pending';

/** Статистика прогона сверки. */
export interface AtolReconcileStats {
  /** Сколько заказов реально опрошено (ответ API получен и разобран). */
  checked: number;
  /** По скольким переход payment_status применён в этом прогоне. */
  updated: number;
  /** По скольким сверка не удалась (ошибка API/БД или несошедшаяся сумма). */
  failed: number;
  /** Прогон не выполнялся: mock-режим или занятый advisory-lock. */
  skipped: boolean;
}

/**
 * Результат попытки взять advisory-lock и выполнить критическую секцию.
 * acquired=false → секция НЕ выполнялась (лок держит параллельный прогон).
 */
export type WithLockResult<T> = { acquired: true; result: T } | { acquired: false };

/** Сериализатор прогона: берёт advisory-lock по ключу и выполняет fn под ним. */
export type WithLock = <T>(key: string, fn: () => Promise<T>) => Promise<WithLockResult<T>>;

/**
 * Дефолтная реализация withLock через sql.begin + pg_try_advisory_xact_lock.
 * hashtext(key) → детерминированный int4-ключ; xact-lock держится до конца
 * транзакции, поэтому критическая секция гарантированно одна на кластер БД.
 * Локальная копия (не импорт из tbank/cron) — провайдеры включаются
 * независимо друг от друга и не должны зависеть один от другого.
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

/** Подтверждённый эквайером результат сверки одного заказа. */
export interface VerifiedStatus {
  /** Числовой paymentStatus из ответа API, либо null если поле не пришло. */
  code: number | null;
  /** Подтверждённая сумма платежа в КОПЕЙКАХ, либо null если поле не пришло. */
  amountKop: number | null;
}

/** Инъецируемые зависимости воркера сверки (для тестов без БД и сети). */
export interface ReconcileDeps {
  /** Сериализатор прогона (advisory-lock). По умолчанию — withAdvisoryLock. */
  withLock: WithLock;
  /** Mock-режим: боевого токена нет, в сеть ходить нельзя. */
  isMock: () => boolean;
  /** Поиск кандидатов. По умолчанию — findPendingAtolPayments. */
  findCandidates: (limit?: number) => Promise<PendingAtolOrder[]>;
  /** Запрос статуса у АТОЛа — единственный достоверный источник факта оплаты. */
  fetchStatus: (atolOrderId: string) => Promise<VerifiedStatus>;
  /** Применение перехода payment_status. По умолчанию — applyPaymentStatus. */
  applyStatus: (orderId: string, to: PaymentStatus, comment: string) => Promise<boolean>;
}

function defaultReconcileDeps(): ReconcileDeps {
  // Сервис создаётся лениво, ОДИН на прогон: конструктор читает конфигурацию
  // из окружения, и создавать его на каждый заказ незачем.
  let service: AtolPaymentService | null = null;
  const svc = () => (service ??= new AtolPaymentService());

  return {
    withLock: withAdvisoryLock,
    isMock: () => isAtolMock(),
    findCandidates: findPendingAtolPayments,
    fetchStatus: async (atolOrderId) => {
      const res = await svc().fetchStatus(atolOrderId);
      return {
        code: typeof res.paymentStatus === 'number' ? res.paymentStatus : null,
        amountKop: typeof res.amount === 'number' ? res.amount : null,
      };
    },
    applyStatus: applyPaymentStatus,
  };
}

/**
 * atol-reconcile-pending: по заказам с незавершённой оплатой запрашивает
 * GET /payments/{orderId}/status и доводит payment_status.
 *
 * Для АТОЛа это не запасной путь: при отсутствии подписи у callback именно
 * ответ API — основание считать заказ оплаченным.
 */
export async function runAtolReconcilePending(
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<AtolReconcileStats> {
  // MOCK: боевого токена нет — реальных платежей не существует, сверять нечего.
  // В сеть НЕ идём: запрос без токена вернёт 403 AUTH_ERROR и засорит логи
  // ошибками, из-за которых не будет видно настоящих сбоев.
  if (deps.isMock()) {
    log.warn('atol.cron: mock-режим — сверка пропущена, оплата ненастоящая');
    return { checked: 0, updated: 0, failed: 0, skipped: true };
  }

  const locked = await deps.withLock(RECONCILE_LOCK_KEY, async () => {
    const stats: AtolReconcileStats = { checked: 0, updated: 0, failed: 0, skipped: false };
    const pending = await deps.findCandidates(RECONCILE_PENDING_LIMIT);

    for (const p of pending) {
      // 🔴 try/catch ВНУТРИ цикла: отказ API по одному заказу (PAYMENT_NOT_FOUND,
      // таймаут, 5xx) не имеет права оставить без сверки остальные заказы.
      try {
        const verified = await deps.fetchStatus(p.atolOrderId);
        stats.checked += 1;

        const next = mapPaymentStatus(verified.code);

        // Авто-перехода нет — штатный исход, а не ошибка. Сюда попадают:
        // частичные возврат/отмена (7/8), «банк не ответил» (2) и «ошибка,
        // повтор возможен» (12). 🔴 Частичные 7/8 mapPaymentStatus намеренно
        // отдаёт как null: авто-refunded закрыл бы заказ целиком и освободил
        // ВЕСЬ резерв остатков, хотя вернулась лишь часть денег. Решает оператор.
        if (!next) continue;

        // Статус уже такой — сверка ничего не меняет (типичный случай:
        // pending остаётся pending, пока покупатель на форме оплаты).
        if (next === p.paymentStatus) continue;

        // 🔴 СВЕРКА СУММЫ. Совпадения статуса мало: платёж может быть выполнен
        // на сумму МЕНЬШЕ заказа (частичное списание, подмена суммы на форме).
        // Пометить такой заказ paid — отгрузить товар за неполные деньги.
        // Правило то же, что в service.handleCallback, и та же арифметика
        // (rublesToKopecks: разбор строки, не float — иначе расхождение в копейку).
        if (next === 'paid') {
          const expectedKop = rublesToKopecks(p.grandTotal);
          if (verified.amountKop !== null && verified.amountKop < expectedKop) {
            stats.failed += 1;
            log.error(
              'atol.cron: 🔴 подтверждённая сумма меньше суммы заказа — оплата НЕ засчитана, нужен ручной разбор',
              {
                orderNumber: p.orderNumber,
                atolOrderId: p.atolOrderId,
                verifiedAmountKop: verified.amountKop,
                expectedKop,
              },
            );
            continue;
          }
        }

        const applied = await deps.applyStatus(
          p.orderId,
          next,
          `АТОЛ: сверка — ${describeAtolStatus(verified.code)}`,
        );
        if (applied) {
          stats.updated += 1;
          log.info('atol.cron: статус оплаты доведён сверкой', {
            orderNumber: p.orderNumber,
            from: p.paymentStatus,
            to: next,
            atolStatus: verified.code,
          });
        }
      } catch (e) {
        stats.failed += 1;
        log.warn('atol.cron: не удалось сверить заказ', {
          orderNumber: p.orderNumber,
          atolOrderId: p.atolOrderId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return stats;
  });

  if (!locked.acquired) {
    // Перекрывшийся прогон уже держит лок — этот прогон no-op, кандидаты не
    // читались и не опрашивались (иначе два тика дёргали бы API по одним заказам).
    log.warn('atol.cron: параллельный прогон держит лок — сверка пропущена');
    return { checked: 0, updated: 0, failed: 0, skipped: true };
  }
  return locked.result;
}
