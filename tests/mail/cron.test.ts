import { describe, it, expect } from 'vitest';

import {
  runRetryFailed,
  MAIL_RETRY_LIMIT,
  MAIL_RETRY_LOCK_KEY,
  type RetryFailedDeps,
  type MailRetryStats,
} from '@/lib/mail/cron';
import type { MailLogEntry, MailSendResult } from '@/lib/mail/types';

/**
 * Досылка неотправленных писем (крон-задача mail/retry-failed).
 *
 * ЗАЧЕМ, если отправка уже ретраит внутри себя: внутренние ретраи живут в
 * пределах одного запроса (секунды). Релей, лежавший десять минут, оставил бы
 * письмо с кодом сертификата — ДЕНЬГАМИ на предъявителя — в статусе failed
 * навсегда. Эта задача периодически добирает такие записи.
 *
 * Калька с lib/gift-certificates/cron.ts: инъекция зависимостей, весь прогон под
 * advisory-lock, падение по письму не валит прогон, ok=false → роут отдаёт не-2xx.
 */

function entry(id: string, over: Partial<MailLogEntry> = {}): MailLogEntry {
  return {
    id,
    recipient: 'ivan@example.test',
    template: 'gift_certificate',
    locale: 'ru',
    status: 'failed',
    attempts: 1,
    error: 'ECONNREFUSED',
    orderId: 'ord-1',
    subject: 'Ваш сертификат',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    sentAt: null,
    ...over,
  };
}

function harness(overrides: Partial<RetryFailedDeps> = {}) {
  const resent: string[] = [];
  const logs: string[] = [];
  const deps: RetryFailedDeps = {
    findRetryable: async () => [entry('log-1'), entry('log-2')],
    resend: async (id): Promise<MailSendResult> => {
      resent.push(id);
      return { ok: true, status: 'sent', attempts: 1, logId: id };
    },
    closeRetried: async () => {},
    withLock: async (_key, fn) => ({ acquired: true, result: await fn() }),
    logger: {
      debug: (m) => logs.push(`debug:${m}`),
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
      child: () => deps.logger,
    },
    ...overrides,
  };
  return { deps, resent, logs };
}

describe('mail/cron — retry-failed', () => {
  it('досылает все найденные письма и отчитывается', async () => {
    const h = harness();
    const stats: MailRetryStats = await runRetryFailed(h.deps);

    expect(stats.ok).toBe(true);
    expect(stats.scanned).toBe(2);
    expect(stats.sent).toBe(2);
    expect(stats.failed).toBe(0);
    expect(h.resent).toEqual(['log-1', 'log-2']);
  });

  it('нечего досылать → пустой успешный прогон', async () => {
    const h = harness({ findRetryable: async () => [] });
    const stats = await runRetryFailed(h.deps);
    expect(stats.ok).toBe(true);
    expect(stats.scanned).toBe(0);
    expect(stats.sent).toBe(0);
  });

  it('advisory-lock занят → штатный no-op (lockSkipped), кандидаты НЕ читаются', async () => {
    let read = 0;
    const h = harness({
      withLock: async () => ({ acquired: false }),
      findRetryable: async () => {
        read += 1;
        return [];
      },
    });
    const stats = await runRetryFailed(h.deps);
    expect(stats.lockSkipped).toBe(true);
    expect(stats.ok).toBe(true);
    expect(read).toBe(0);
  });

  it('прогон идёт под ключом-константой (два инстанса не молотят одно и то же)', async () => {
    const keys: string[] = [];
    const h = harness({
      withLock: async (key, fn) => {
        keys.push(key);
        return { acquired: true, result: await fn() };
      },
    });
    await runRetryFailed(h.deps);
    expect(keys).toEqual([MAIL_RETRY_LOCK_KEY]);
    expect(MAIL_RETRY_LOCK_KEY.length).toBeGreaterThan(0);
  });

  it('провал одного письма не валит прогон, но делает ok=false', async () => {
    const h = harness({
      resend: async (id): Promise<MailSendResult> =>
        id === 'log-1'
          ? { ok: false, status: 'failed', attempts: 3, logId: id, error: 'релей отказал' }
          : { ok: true, status: 'sent', attempts: 1, logId: id },
    });
    const stats = await runRetryFailed(h.deps);
    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.ok).toBe(false);
  });

  it('исключение в resend ловится: прогон продолжается, письмо в failed', async () => {
    const h = harness({
      resend: async (id) => {
        if (id === 'log-1') throw new Error('boom');
        return { ok: true, status: 'sent', attempts: 1, logId: id };
      },
    });
    const stats = await runRetryFailed(h.deps);
    expect(stats.failed).toBe(1);
    expect(stats.sent).toBe(1);
    expect(stats.ok).toBe(false);
  });

  it('почта выключена → письма помечаются skipped, прогон успешен (не спамим ошибками)', async () => {
    const h = harness({
      resend: async (id): Promise<MailSendResult> => ({
        ok: true,
        status: 'skipped',
        attempts: 0,
        logId: id,
        reason: 'mail_disabled',
      }),
    });
    const stats = await runRetryFailed(h.deps);
    expect(stats.ok).toBe(true);
    expect(stats.sent).toBe(0);
    expect(stats.skipped).toBe(2);
  });

  it('лимит выборки за тик конечен (не блокируем БД на всей истории)', () => {
    expect(MAIL_RETRY_LIMIT).toBeGreaterThan(0);
    expect(MAIL_RETRY_LIMIT).toBeLessThanOrEqual(500);
  });

  it('🔴 тело письма нигде не всплывает — досылка работает по id записи журнала', async () => {
    const h = harness();
    const stats = await runRetryFailed(h.deps);
    expect(JSON.stringify(stats)).not.toMatch(/код|code|SECRET/i);
  });
});

/**
 * 🔴 ЗАЩИТА ОТ ВЕЧНОЙ ДОСЫЛКИ (и от спама покупателю).
 *
 * Досылка пересобирает письмо и отправляет его НОВОЙ записью журнала — старая
 * остаётся failed. Если её не «закрывать», выборка кандидатов будет возвращать
 * ту же строку каждые 20 минут ВЕЧНО, и покупатель получит одно и то же письмо
 * (в т.ч. с кодом сертификата) десятки раз. Поэтому обработанная запись обязана
 * перестать быть кандидатом.
 */
describe('mail/cron — обработанная запись не досылается вечно', () => {
  it('после успешной досылки старая запись СНИМАЕТСЯ с очереди', async () => {
    const closed: string[] = [];
    const h = harness({
      findRetryable: async () => [entry('log-1')],
      closeRetried: async (id) => {
        closed.push(id);
      },
    });
    await runRetryFailed(h.deps);
    expect(closed, 'запись осталась кандидатом — крон будет слать письмо вечно').toEqual([
      'log-1',
    ]);
  });

  it('после НЕудачной досылки запись тоже снимается (её заменила новая failed-строка)', async () => {
    const closed: string[] = [];
    const h = harness({
      findRetryable: async () => [entry('log-1')],
      resend: async (id) => ({ ok: false, status: 'failed', attempts: 3, logId: id }),
      closeRetried: async (id) => {
        closed.push(id);
      },
    });
    await runRetryFailed(h.deps);
    // Новая попытка завела СВОЮ строку журнала; старую держать в очереди нельзя,
    // иначе одна авария размножается в бесконечную очередь дубликатов.
    expect(closed).toEqual(['log-1']);
  });

  it('исключение в resend НЕ снимает запись (попытки не было — пусть повторится)', async () => {
    const closed: string[] = [];
    const h = harness({
      findRetryable: async () => [entry('log-1')],
      resend: async () => {
        throw new Error('БД недоступна');
      },
      closeRetried: async (id) => {
        closed.push(id);
      },
    });
    await runRetryFailed(h.deps);
    expect(closed).toEqual([]);
  });

  it('сбой снятия с очереди не валит прогон (это наблюдаемость, не деньги)', async () => {
    const h = harness({
      findRetryable: async () => [entry('log-1')],
      closeRetried: async () => {
        throw new Error('БД недоступна');
      },
    });
    const stats = await runRetryFailed(h.deps);
    expect(stats.sent).toBe(1);
  });
});
