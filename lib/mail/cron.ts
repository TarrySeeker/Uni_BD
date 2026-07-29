/**
 * ДОСЫЛКА неотправленных писем (крон-задача mail/retry-failed).
 *
 * ЗАЧЕМ, если отправка уже ретраит внутри себя. Внутренние ретраи
 * (MAIL_MAX_ATTEMPTS) живут в пределах одного запроса — это секунды. Релей,
 * лежавший десять минут (перезапуск почтового сервера, исчерпанная квота
 * провайдера, DNS моргнул), оставил бы письмо с кодом подарочного сертификата —
 * ДЕНЬГАМИ НА ПРЕДЪЯВИТЕЛЯ — в статусе failed навсегда, и покупатель не получил
 * бы то, за что заплатил.
 *
 * Калька с lib/gift-certificates/cron.ts (runIssuePending): инъекция
 * зависимостей (юниты без БД и сети, ADR-004), весь прогон под транзакционным
 * advisory-lock, ошибка по одному письму не валит прогон.
 *
 * Гарантии:
 *   • устойчивость — падение по письму учитывается в failed, цикл продолжается;
 *   • честный итог — ok=false, если хоть одно письмо не доехало: роут обязан
 *     отдать не-2xx, иначе провал выглядит успехом в логах cron-контейнера;
 *   • «почта не настроена» НЕ считается провалом — иначе магазин без SMTP
 *     каждые полчаса ронял бы крон-задачу и шумел бы в логи вечно.
 *
 * 🔴 ТЕЛА ПИСЕМ И КОДЫ СЕРТИФИКАТОВ В СТАТИСТИКУ И ЛОГИ НЕ ПОПАДАЮТ: досылка
 * работает по id записи журнала, а тело рендерится заново из заказа.
 */

import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db/client';
import { logger as appLogger, type Logger } from '@/lib/logger';

import { findRetryableMail, markMailRetried } from './repository';
import { resendMailById } from './resend';
import type { MailLogEntry, MailSendResult } from './types';

/** Сколько писем добираем за один тик (страховка от долгого прогона). */
export const MAIL_RETRY_LIMIT = 50;

/** Стабильный ключ advisory-lock: два инстанса не шлют одно письмо дважды. */
export const MAIL_RETRY_LOCK_KEY = 'mail:retry-failed';

/** Результат попытки взять advisory-lock (acquired=false → секция не шла). */
export type WithLockResult<T> = { acquired: true; result: T } | { acquired: false };

/** Сериализатор прогона: берёт advisory-lock по ключу и выполняет fn под ним. */
export type WithLock = <T>(key: string, fn: () => Promise<T>) => Promise<WithLockResult<T>>;

/**
 * Дефолтная реализация withLock через sql.begin + pg_try_advisory_xact_lock.
 * Локальная копия (не импорт из lib/gift-certificates/cron) — по той же причине,
 * что и в крон-воркерах lib/payments: модули включаются независимо друг от друга.
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

/** Статистика прогона. Адресатов и тем здесь нет намеренно. */
export interface MailRetryStats {
  /** false → хотя бы одно письмо не доехало; роут отдаёт не-2xx. */
  ok: boolean;
  /** Сколько записей-кандидатов просмотрено. */
  scanned: number;
  /** Сколько писем удалось дослать. */
  sent: number;
  /** Сколько писем снова не доехало. */
  failed: number;
  /** Сколько пропущено штатно (почта не настроена / нет адреса). */
  skipped: number;
  /** Прогон пропущен: advisory-lock держит параллельный прогон (штатный no-op). */
  lockSkipped: boolean;
}

/** Инъецируемые зависимости воркера (для юнитов без БД). */
export interface RetryFailedDeps {
  findRetryable: (limit?: number) => Promise<MailLogEntry[]>;
  resend: (logId: string) => Promise<MailSendResult>;
  /**
   * Снимает УЖЕ ОБРАБОТАННУЮ запись с очереди досылки.
   *
   * 🔴 БЕЗ ЭТОГО ШАГА КРОН СПАМИТ ПОКУПАТЕЛЯ. Досылка не «чинит» старую строку —
   * она пересобирает письмо и заводит НОВУЮ запись журнала (тела в старой нет,
   * см. lib/mail/resend.ts). Старая при этом остаётся в статусе failed, то есть
   * ОСТАЁТСЯ КАНДИДАТОМ: следующий тик через 20 минут возьмёт её снова, и ещё
   * раз, и ещё — покупатель получит одно и то же письмо (в том числе с кодом
   * подарочного сертификата) десятки раз, а по одной аварии релея вырастет
   * бесконечная очередь дубликатов.
   */
  closeRetried: (logId: string) => Promise<void>;
  withLock: WithLock;
  logger: Logger;
}

/** Прод-зависимости (реальная БД + прод-конвейер отправки). */
export function productionRetryFailedDeps(): RetryFailedDeps {
  return {
    findRetryable: findRetryableMail,
    resend: resendMailById,
    closeRetried: markMailRetried,
    withLock: withAdvisoryLock,
    logger: appLogger.child({ module: 'mail-cron' }),
  };
}

function emptyStats(lockSkipped: boolean): MailRetryStats {
  return { ok: true, scanned: 0, sent: 0, failed: 0, skipped: 0, lockSkipped };
}

/**
 * retry-failed: добирает письма со статусом failed и шлёт их заново.
 *
 * АНТИ-ГОНКА. Выборка кандидатов их НЕ помечает, поэтому перекрывшиеся тики (или
 * два инстанса приложения) отправили бы покупателю ДВА одинаковых письма. Для
 * письма с кодом сертификата это ещё и повод для паники («мне пришло два кода —
 * их два?»). Поэтому ВЕСЬ прогон — под транзакционным advisory-lock; лок не взят
 * → выходим как lockSkipped, НЕ читая кандидатов.
 */
export async function runRetryFailed(
  deps: RetryFailedDeps = productionRetryFailedDeps(),
): Promise<MailRetryStats> {
  const locked = await deps.withLock(MAIL_RETRY_LOCK_KEY, async () => {
    const stats = emptyStats(false);

    const candidates = await deps.findRetryable(MAIL_RETRY_LIMIT);
    stats.scanned = candidates.length;

    for (const candidate of candidates) {
      let attempted = false;
      try {
        const result = await deps.resend(candidate.id);
        attempted = true;
        if (result.status === 'sent') stats.sent += 1;
        else if (result.status === 'skipped') stats.skipped += 1;
        else stats.failed += 1;
      } catch (err) {
        // Отправитель объявлен «не бросающим», но крон обязан переживать и это.
        // attempted остаётся false: попытки фактически не было (упало чтение
        // журнала/БД), поэтому запись СОХРАНЯЕТ место в очереди — иначе одна
        // транзиентная ошибка навсегда лишила бы покупателя письма с кодом.
        stats.failed += 1;
        deps.logger.error('досылка: письмо не обработано', {
          logId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (attempted) {
        // Снимаем с очереди НЕЗАВИСИМО от исхода: у новой попытки уже есть своя
        // строка журнала (успешная или failed), и именно она — актуальный статус.
        // Провал снятия не влияет на итог прогона: это наблюдаемость, не деньги.
        try {
          await deps.closeRetried(candidate.id);
        } catch (err) {
          deps.logger.warn('досылка: не удалось снять запись с очереди', {
            logId: candidate.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    stats.ok = stats.failed === 0;
    if (stats.sent > 0 || stats.failed > 0) {
      deps.logger.info('досылка писем завершена', {
        scanned: stats.scanned,
        sent: stats.sent,
        failed: stats.failed,
        skipped: stats.skipped,
      });
    }
    return stats;
  });

  if (!locked.acquired) return emptyStats(true);
  return locked.result;
}
