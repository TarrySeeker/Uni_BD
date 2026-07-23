import { describe, expect, it, vi } from 'vitest';

/**
 * Крон-догоняльщик автовыпуска сертификатов (ТЗ п.11, трек T3).
 *
 * ЗАЧЕМ ОН ЕСТЬ: post-commit хук вебхука может не выполниться (рестарт процесса,
 * сбой), у Альфа-Банка вообще нет крон-сверки платежей, а статус заказа могут
 * поправить руками в БД. Во всех трёх случаях сертификат по оплаченному заказу
 * не выпустится НИКОГДА — эту дыру закрывает догоняющий прогон.
 *
 * Логика проверяется на инъецированных зависимостях (без БД и сети, ADR-004):
 * выборка кандидатов, сериализация advisory-lock, устойчивость к падению одного
 * заказа, идемпотентность повторного прогона.
 */

import {
  GIFT_ISSUE_PENDING_LIMIT,
  GIFT_ISSUE_PENDING_LOCK_KEY,
  runIssuePending,
  type IssuePendingDeps,
  type WithLock,
} from '@/lib/gift-certificates/cron';
import type { AutoIssueReport } from '@/lib/gift-certificates/auto-issue';
import type { PendingGiftIssueOrder } from '@/lib/gift-certificates/repository';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silentLogger;
  },
};

function candidates(n: number): PendingGiftIssueOrder[] {
  return Array.from({ length: n }, (_, i) => ({
    orderId: `ord-${i}`,
    orderNumber: `A-${i}`,
    paidAt: new Date('2026-07-20T10:00:00Z'),
  }));
}

function report(orderId: string, patch: Partial<AutoIssueReport> = {}): AutoIssueReport {
  return { orderId, ok: true, issued: 0, skipped: 0, failed: 0, items: [], ...patch };
}

/** withLock, который лок ВЫДАЁТ (критическая секция выполняется). */
const grantingLock = vi.fn(async (_key: string, fn: () => Promise<unknown>) => ({
  acquired: true as const,
  result: await fn(),
})) as unknown as WithLock;

function deps(over: Partial<IssuePendingDeps> = {}): IssuePendingDeps {
  return {
    findCandidates: async () => [],
    issueForOrder: async (orderId) => report(orderId),
    withLock: grantingLock,
    logger: silentLogger,
    ...over,
  };
}

describe('runIssuePending — догоняющий автовыпуск', () => {
  it('обрабатывает найденных кандидатов и суммирует выпущенное', async () => {
    const issueForOrder = vi.fn(async (orderId: string) =>
      report(orderId, { issued: 2, items: [] }),
    );
    const stats = await runIssuePending(
      deps({ findCandidates: async () => candidates(3), issueForOrder }),
    );

    expect(issueForOrder).toHaveBeenCalledTimes(3);
    expect(stats.scanned).toBe(3);
    expect(stats.issued).toBe(6);
    expect(stats.ordersIssued).toBe(3);
    expect(stats.failed).toBe(0);
    expect(stats.ok).toBe(true);
    expect(stats.lockSkipped).toBe(false);
  });

  it('запрашивает кандидатов пачкой не больше LIMIT (прогон ограничен)', async () => {
    const findCandidates = vi.fn(async () => candidates(0));
    await runIssuePending(deps({ findCandidates }));
    expect(findCandidates).toHaveBeenCalledWith(GIFT_ISSUE_PENDING_LIMIT);
    expect(GIFT_ISSUE_PENDING_LIMIT).toBeLessThanOrEqual(100);
  });

  it('ошибка (throw) по одному заказу НЕ валит прогон — остальные обрабатываются', async () => {
    const issueForOrder = vi.fn(async (orderId: string) => {
      if (orderId === 'ord-1') throw new Error('БД моргнула');
      return report(orderId, { issued: 1 });
    });
    const stats = await runIssuePending(
      deps({ findCandidates: async () => candidates(3), issueForOrder }),
    );

    // Главное: заказы после упавшего всё равно обработаны.
    expect(issueForOrder).toHaveBeenCalledTimes(3);
    expect(stats.issued).toBe(2);
    expect(stats.failed).toBe(1);
    // Прогон неуспешен → роут обязан отдать не-2xx (иначе провал выглядит успехом).
    expect(stats.ok).toBe(false);
  });

  it('отчёт автовыпуска с ok:false (не бросает, но не доделал) считается провалом заказа', async () => {
    const stats = await runIssuePending(
      deps({
        findCandidates: async () => candidates(2),
        issueForOrder: async (orderId) =>
          orderId === 'ord-0' ? report(orderId, { ok: false, failed: 1 }) : report(orderId),
      }),
    );
    expect(stats.failed).toBe(1);
    expect(stats.ok).toBe(false);
  });

  it('штатные пропуски (нечего выпускать, автовыпуск выключен) провалом НЕ считаются', async () => {
    const stats = await runIssuePending(
      deps({
        findCandidates: async () => candidates(2),
        issueForOrder: async (orderId) => report(orderId, { reason: 'no_gift_items' }),
      }),
    );
    expect(stats.failed).toBe(0);
    expect(stats.ok).toBe(true);
    expect(stats.issued).toBe(0);
    expect(stats.ordersIssued).toBe(0);
  });

  it('нет кандидатов → пустой успешный прогон', async () => {
    const stats = await runIssuePending(deps());
    expect(stats).toEqual({
      ok: true,
      scanned: 0,
      issued: 0,
      ordersIssued: 0,
      failed: 0,
      lockSkipped: false,
    });
  });

  it('код сертификата в статистику прогона не попадает (деньги на предъявителя)', async () => {
    const stats = await runIssuePending(
      deps({
        findCandidates: async () => candidates(1),
        issueForOrder: async (orderId) =>
          report(orderId, {
            issued: 1,
            items: [{ orderItemId: 'it-1', status: 'issued', certificateId: 'cert-1' }],
          }),
      }),
    );
    expect(JSON.stringify(stats)).not.toContain('cert-1');
    expect(JSON.stringify(stats)).not.toContain('it-1');
  });
});

describe('runIssuePending — сериализация advisory-lock', () => {
  it('лок получен → критическая секция выполняется, ключ стабильный', async () => {
    const withLock = vi.fn(async (_key: string, fn: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await fn(),
    }));
    const issueForOrder = vi.fn(async (orderId: string) => report(orderId, { issued: 1 }));
    await runIssuePending(
      deps({
        findCandidates: async () => candidates(1),
        issueForOrder,
        withLock: withLock as unknown as WithLock,
      }),
    );
    expect(withLock).toHaveBeenCalledOnce();
    expect(withLock.mock.calls[0][0]).toBe(GIFT_ISSUE_PENDING_LOCK_KEY);
    expect(issueForOrder).toHaveBeenCalledTimes(1);
  });

  it('лок НЕ получен (параллельный прогон) → no-op: ни выборки, ни выпуска', async () => {
    const findCandidates = vi.fn(async () => candidates(5));
    const issueForOrder = vi.fn(async (orderId: string) => report(orderId, { issued: 1 }));
    const withLock = vi.fn(async () => ({ acquired: false as const }));

    const stats = await runIssuePending(
      deps({ findCandidates, issueForOrder, withLock: withLock as unknown as WithLock }),
    );

    expect(findCandidates).not.toHaveBeenCalled();
    expect(issueForOrder).not.toHaveBeenCalled();
    // lockSkipped — не сбой: прогон уже идёт в другом инстансе, роут отдаёт 2xx.
    expect(stats).toEqual({
      ok: true,
      scanned: 0,
      issued: 0,
      ordersIssued: 0,
      failed: 0,
      lockSkipped: true,
    });
  });
});

describe('runIssuePending — идемпотентность (повторный прогон не плодит коды)', () => {
  /**
   * Фейк «БД»: один заказ с одной позицией-сертификатом. Выпуск создаёт код
   * только если по позиции его ещё нет (эмуляция частичного UNIQUE 0054), а
   * выборка кандидатов, как в findOrdersPendingGiftIssue, отдаёт лишь заказы с
   * невыпущенными позициями.
   */
  it('второй прогон подряд не создаёт второй код по той же позиции', async () => {
    const issuedByItem = new Map<string, string>();
    const items = [{ orderId: 'ord-0', itemId: 'item-0' }];

    const d = deps({
      findCandidates: async () =>
        items.some((i) => !issuedByItem.has(i.itemId))
          ? [{ orderId: 'ord-0', orderNumber: 'A-0', paidAt: new Date() }]
          : [],
      issueForOrder: async (orderId) => {
        let issued = 0;
        let skipped = 0;
        for (const it of items.filter((i) => i.orderId === orderId)) {
          if (issuedByItem.has(it.itemId)) {
            skipped += 1;
            continue;
          }
          issuedByItem.set(it.itemId, `code-${issuedByItem.size + 1}`);
          issued += 1;
        }
        return report(orderId, { issued, skipped });
      },
    });

    const first = await runIssuePending(d);
    const second = await runIssuePending(d);

    expect(first.issued).toBe(1);
    expect(second.issued).toBe(0);
    expect(second.scanned).toBe(0);
    expect(issuedByItem.size).toBe(1);
  });
});
