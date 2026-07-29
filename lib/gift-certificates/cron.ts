/**
 * ДОГОНЯЮЩИЙ автовыпуск подарочных сертификатов (ТЗ владельца п.11).
 *
 * ЗАЧЕМ, если выпуск уже висит на фиксации оплаты: у хука есть три известные
 * дыры, каждая из которых оставляет оплаченный сертификат без кода НАВСЕГДА —
 *   • хук после коммита не выполнился (рестарт процесса, падение) либо выпуск
 *     упал, а ошибка сознательно проглочена: отвечать провайдеру не-2xx нельзя,
 *     иначе он ретраит событие (см. autoIssueGiftsAfterCommit в lib/payments/*);
 *   • заказ доведён до paid путём, где хук ещё не подключён: платформа
 *     мультитенантная, эквайеры/импортёры заказов добавляются per-shop, и новый
 *     адаптер легко забыть пробросить в автовыпуск;
 *   • статус заказа поправили руками в БД (миграция, поддержка).
 * Этот воркер периодически добирает такие заказы. Он ничего не «чинит» задним
 * числом: просто вызывает тот же конвейер автовыпуска, что и вебхук.
 *
 * Калька с lib/cdek/cron.ts (runCreatePending): инъекция зависимостей (юниты без
 * БД и сети, ADR-004), весь прогон под транзакционным advisory-lock, ошибка по
 * одному заказу не валит прогон.
 *
 * Гарантии:
 *   • идемпотентность — держится на частичном UNIQUE (issued_order_item_id)
 *     из миграции 0054; повторный прогон второй код по позиции не создаёт;
 *   • устойчивость — падение по заказу учитывается в failed, цикл продолжается;
 *   • честный итог — ok=false, если хоть один заказ не доехал: роут обязан
 *     отдать не-2xx, иначе провал выглядит успехом в логах cron-контейнера.
 *
 * 🔴 КОДЫ СЕРТИФИКАТОВ В СТАТИСТИКУ И ЛОГИ НЕ ПОПАДАЮТ — это деньги на
 * предъявителя, а логи уезжают в docker json-file (см. шапку auto-issue.ts).
 *
 * Локальная копия withAdvisoryLock (не импорт из lib/cdek/cron) — по той же
 * причине, что и в крон-воркерах lib/payments: модули включаются независимо.
 */

import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db/client';
import { logger as appLogger, type Logger } from '@/lib/logger';

import { autoIssueGiftsForPaidOrder, type AutoIssueReport } from './auto-issue';
import { GIFT_EXPIRE_TASK } from './lifecycle';
import {
  findOrdersPendingGiftIssue,
  markExpiredGiftCertificates,
  type PendingGiftIssueOrder,
} from './repository';

/** Лимит заказов на один прогон (как у СДЭК create-pending). */
export const GIFT_ISSUE_PENDING_LIMIT = 100;

/** Стабильный ключ advisory-lock для сериализации прогонов. */
export const GIFT_ISSUE_PENDING_LOCK_KEY = 'gift:issue-pending';

/** Сколько сертификатов помечаем истёкшими за один тик (страховка от долгой блокировки). */
export const GIFT_EXPIRE_LIMIT = 500;

/** Ключ advisory-lock задачи истечения (своё пространство, не пересекается с выпуском). */
export const GIFT_EXPIRE_LOCK_KEY = `gift:${GIFT_EXPIRE_TASK}`;

/**
 * Результат попытки взять advisory-lock и выполнить критическую секцию.
 * acquired=false → секция НЕ выполнялась (лок занят другим процессом).
 */
export type WithLockResult<T> = { acquired: true; result: T } | { acquired: false };

/** Сериализатор прогона: берёт advisory-lock по ключу и выполняет fn под ним. */
export type WithLock = <T>(key: string, fn: () => Promise<T>) => Promise<WithLockResult<T>>;

/**
 * Дефолтная реализация withLock через sql.begin + pg_try_advisory_xact_lock.
 * hashtext(key) → int4-ключ (детерминированный на ключ). Лок держится до конца
 * транзакции, поэтому критическая секция гарантированно одна на кластер.
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

/** Статистика прогона. Кодов и id сертификатов здесь нет намеренно. */
export interface IssuePendingStats {
  /** false → хотя бы один заказ не доехал; роут отдаёт не-2xx. */
  ok: boolean;
  /** Сколько заказов-кандидатов просмотрено. */
  scanned: number;
  /** Сколько сертификатов выпущено суммарно. */
  issued: number;
  /** По скольким заказам выпущен хотя бы один сертификат. */
  ordersIssued: number;
  /** По скольким заказам выпуск не удался (исключение или ok:false в отчёте). */
  failed: number;
  /** Прогон пропущен: advisory-lock держит параллельный прогон (штатный no-op). */
  lockSkipped: boolean;
}

/** Инъецируемые зависимости воркера (для юнитов без БД). */
export interface IssuePendingDeps {
  findCandidates: (limit?: number) => Promise<PendingGiftIssueOrder[]>;
  issueForOrder: (orderId: string) => Promise<AutoIssueReport>;
  withLock: WithLock;
  logger: Logger;
}

/** Прод-зависимости (реальная БД + прод-конвейер автовыпуска). */
export function productionIssuePendingDeps(): IssuePendingDeps {
  return {
    findCandidates: findOrdersPendingGiftIssue,
    issueForOrder: autoIssueGiftsForPaidOrder,
    withLock: withAdvisoryLock,
    logger: appLogger.child({ module: 'gift-cron' }),
  };
}

/**
 * issue-pending: добирает оплаченные заказы, по которым сертификаты ещё не
 * выпущены, и прогоняет их через конвейер автовыпуска.
 *
 * АНТИ-ГОНКА. Выборка кандидатов их НЕ помечает, поэтому перекрывшиеся тики
 * (или два инстанса приложения) видели бы одни и те же заказы одновременно.
 * Дубль кода не появится (частичный UNIQUE по позиции), но конкурирующие
 * транзакции молотили бы БД впустую. Поэтому ВЕСЬ прогон — под транзакционным
 * advisory-lock; лок не взят → выходим как lockSkipped, НЕ читая кандидатов.
 */
export async function runIssuePending(
  deps: IssuePendingDeps = productionIssuePendingDeps(),
): Promise<IssuePendingStats> {
  const locked = await deps.withLock(GIFT_ISSUE_PENDING_LOCK_KEY, async () => {
    const stats: IssuePendingStats = {
      ok: true,
      scanned: 0,
      issued: 0,
      ordersIssued: 0,
      failed: 0,
      lockSkipped: false,
    };

    const candidates = await deps.findCandidates(GIFT_ISSUE_PENDING_LIMIT);
    stats.scanned = candidates.length;

    for (const cand of candidates) {
      try {
        const report = await deps.issueForOrder(cand.orderId);
        stats.issued += report.issued;
        if (report.issued > 0) stats.ordersIssued += 1;
        // Штатные пропуски (нечего выпускать, автовыпуск выключен) — не провал:
        // выборка не умеет отличать позицию-сертификат от обычного товара.
        if (report.ok === false) stats.failed += 1;
      } catch (err) {
        // Конвейер объявлен «не бросающим», но крон обязан переживать и это.
        stats.failed += 1;
        deps.logger.error('догоняющий выпуск: заказ не обработан', {
          orderId: cand.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    stats.ok = stats.failed === 0;
    if (stats.issued > 0 || stats.failed > 0) {
      deps.logger.info('догоняющий выпуск сертификатов завершён', {
        scanned: stats.scanned,
        issued: stats.issued,
        ordersIssued: stats.ordersIssued,
        failed: stats.failed,
      });
    }
    return stats;
  });

  if (!locked.acquired) {
    return { ok: true, scanned: 0, issued: 0, ordersIssued: 0, failed: 0, lockSkipped: true };
  }
  return locked.result;
}

// -----------------------------------------------------------------------------
// Задача expire-outdated (минор аудита №3).
// -----------------------------------------------------------------------------

/** Инъецируемые зависимости задачи истечения. */
export interface ExpireOutdatedDeps {
  markExpired: (limit?: number) => Promise<number>;
  withLock: WithLock;
  logger: Logger;
}

/** Прод-зависимости задачи истечения. */
export function productionExpireOutdatedDeps(): ExpireOutdatedDeps {
  return {
    markExpired: markExpiredGiftCertificates,
    withLock: withAdvisoryLock,
    logger: appLogger.child({ module: 'gift-cron' }),
  };
}

/**
 * expire-outdated: помечает истёкшие сертификаты статусом 'expired'.
 *
 * ЗАЧЕМ, если деньги и так защищены. Списание проверяет valid_until явно
 * (redeemGiftTx, assertRedeemable), поэтому потратить истёкший код нельзя ни при
 * каком статусе. Но админка показывала такой код «Активен» — оператор не понимал,
 * почему покупателю отказывают, а бейдж и подпись 'expired' простаивали. Задача
 * приводит ОТОБРАЖЕНИЕ в соответствие с уже действующим денежным правилом.
 *
 * Статистика той же формы, что у issue-pending: роут отдаёт её единообразно.
 * Кодов и id в статистике нет намеренно (см. шапку модуля).
 */
export async function runExpireOutdated(
  deps: ExpireOutdatedDeps = productionExpireOutdatedDeps(),
): Promise<IssuePendingStats> {
  const locked = await deps.withLock(GIFT_EXPIRE_LOCK_KEY, async () => {
    const stats: IssuePendingStats = {
      ok: true,
      scanned: 0,
      issued: 0,
      ordersIssued: 0,
      failed: 0,
      lockSkipped: false,
    };
    try {
      const marked = await deps.markExpired(GIFT_EXPIRE_LIMIT);
      // Переиспользуем поля общей статистики: scanned — сколько строк тронуто.
      stats.scanned = marked;
      if (marked > 0) {
        deps.logger.info('пометка истёкших сертификатов завершена', { expired: marked });
      }
    } catch (err) {
      stats.ok = false;
      stats.failed = 1;
      deps.logger.error('пометка истёкших сертификатов сорвалась', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return stats;
  });

  if (!locked.acquired) {
    return { ok: true, scanned: 0, issued: 0, ordersIssued: 0, failed: 0, lockSkipped: true };
  }
  return locked.result;
}
