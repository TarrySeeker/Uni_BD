import { describe, it, expect, vi } from 'vitest';

import {
  runReconcilePending,
  type ReconcileDeps,
  type PendingPaymentCandidate,
} from '@/lib/payments/alfabank/cron';

/**
 * Юнит-тесты воркера сверки Альфа-Банка (порт tests/payments/paykeeper/cron.test.ts).
 * Deps инъецируются — без БД/сети. Воркер существовал, но НЕ был подключён ни к
 * cron-роуту, ни к расписанию и не имел тестов; при включении в планировщик
 * фиксируем его контракт: идемпотентность, устойчивость, анти-гонка (advisory-lock).
 */

const cand = (id: string): PendingPaymentCandidate => ({
  id,
  number: `ADMIK-2026-${id}`,
  paymentId: `alfa-${id}`,
  amountKop: 150000,
});

/** withLock, который всегда берёт лок и выполняет fn. */
const takeLock: ReconcileDeps['withLock'] = async (_k, fn) => ({
  acquired: true,
  result: await fn(),
});

describe('alfabank/cron — runReconcilePending', () => {
  it('опрашивает кандидатов, считает advanced по applied', async () => {
    const deps: ReconcileDeps = {
      withLock: takeLock,
      findCandidates: vi.fn(async () => [cand('001'), cand('002')]),
      reconcile: vi.fn(async (c) => ({ applied: c.id === '001', ok: true })),
    };
    const stats = await runReconcilePending(deps);
    expect(stats.checked).toBe(2);
    expect(stats.advanced).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('ошибка по одному заказу → failed++, прогон продолжается', async () => {
    const deps: ReconcileDeps = {
      withLock: takeLock,
      findCandidates: vi.fn(async () => [cand('001'), cand('002')]),
      reconcile: vi.fn(async (c) => {
        if (c.id === '001') throw new Error('boom');
        return { applied: true, ok: true };
      }),
    };
    const stats = await runReconcilePending(deps);
    expect(stats.failed).toBe(1);
    expect(stats.checked).toBe(1);
    expect(stats.advanced).toBe(1);
  });

  it('лок занят (acquired:false) → lockSkipped, кандидаты НЕ опрашиваются', async () => {
    const reconcile = vi.fn();
    const deps: ReconcileDeps = {
      withLock: async () => ({ acquired: false }),
      findCandidates: vi.fn(async () => [cand('001')]),
      reconcile,
    };
    const stats = await runReconcilePending(deps);
    expect(stats.lockSkipped).toBe(true);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('ключ лока отдельный от других эквайеров (сверки не блокируют друг друга)', async () => {
    const withLock = vi.fn(async (_k: string, fn: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await fn(),
    }));
    const deps: ReconcileDeps = {
      withLock: withLock as unknown as ReconcileDeps['withLock'],
      findCandidates: vi.fn(async () => []),
      reconcile: vi.fn(async () => ({ applied: false, ok: true })),
    };
    await runReconcilePending(deps);
    expect(withLock.mock.calls[0]![0]).toBe('alfabank:reconcile-pending');
  });
});
