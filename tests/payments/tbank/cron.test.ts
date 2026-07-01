import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты cron-сверки платежей Т-Банка (Фича #16, порт tests/cdek/cron*.test.ts).
 *
 * (а) runReconcilePending — с инъекцией deps (мок findCandidates/reconcile/withLock),
 *     без живой БД и сети: статистика checked/advanced/failed, lockSkipped при занятом
 *     advisory-lock, устойчивость (исключение по одному заказу не валит прогон).
 * (б) Секрет-гейт роута /api/cron/payments/[task]: нет секрета → 503, неверный ключ →
 *     401, неизвестная задача → 404, верный ключ + модуль payments выключен → 200 skipped.
 */

import {
  runReconcilePending,
  type ReconcileDeps,
  type PendingPaymentCandidate,
  type WithLock,
} from '@/lib/payments/tbank/cron';

const passLock: WithLock = async <T>(_key: string, fn: () => Promise<T>) => ({
  acquired: true as const,
  result: await fn(),
});
const failLock: WithLock = async () => ({ acquired: false as const });

function candidates(n: number): PendingPaymentCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ord-${i}`,
    number: `TC-${i}`,
    paymentRef: `mock-pay-${i}`,
    amountKop: 100000 + i,
  }));
}

// ---------------------------------------------------------------------------
// runReconcilePending — воркер
// ---------------------------------------------------------------------------

describe('runReconcilePending', () => {
  it('сверяет всех кандидатов; applied → advanced++', async () => {
    const reconcile = vi.fn(async (c: PendingPaymentCandidate) => ({
      ok: true,
      applied: c.id !== 'ord-1', // ord-1 не продвинулся (дубликат/нет маппинга)
    }));
    const deps: ReconcileDeps = {
      withLock: passLock,
      findCandidates: vi.fn(async () => candidates(3)),
      reconcile,
    };
    const stats = await runReconcilePending(deps);
    expect(stats).toEqual({ checked: 3, advanced: 2, failed: 0, lockSkipped: false });
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('исключение по одному заказу → failed++, прогон продолжается', async () => {
    const reconcile = vi.fn(async (c: PendingPaymentCandidate) => {
      if (c.id === 'ord-1') throw new Error('getstate boom');
      return { ok: true, applied: true };
    });
    const deps: ReconcileDeps = {
      withLock: passLock,
      findCandidates: vi.fn(async () => candidates(3)),
      reconcile,
    };
    const stats = await runReconcilePending(deps);
    expect(stats).toEqual({ checked: 2, advanced: 2, failed: 1, lockSkipped: false });
  });

  it('лок НЕ получен (параллельный прогон) → lockSkipped, кандидаты НЕ читаются/сверяются', async () => {
    const findCandidates = vi.fn(async () => candidates(5));
    const reconcile = vi.fn(async () => ({ ok: true, applied: true }));
    const deps: ReconcileDeps = {
      withLock: failLock,
      findCandidates,
      reconcile,
    };
    const stats = await runReconcilePending(deps);
    expect(stats).toEqual({ checked: 0, advanced: 0, failed: 0, lockSkipped: true });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('пустой список кандидатов → нулевая статистика, reconcile не зовётся', async () => {
    const reconcile = vi.fn(async () => ({ ok: true, applied: true }));
    const deps: ReconcileDeps = {
      withLock: passLock,
      findCandidates: vi.fn(async () => []),
      reconcile,
    };
    const stats = await runReconcilePending(deps);
    expect(stats).toEqual({ checked: 0, advanced: 0, failed: 0, lockSkipped: false });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('лок берётся по стабильному ключу tbank:reconcile-pending', async () => {
    const withLock = vi.fn(async (_k: string, fn: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await fn(),
    }));
    const deps: ReconcileDeps = {
      withLock: withLock as unknown as WithLock,
      findCandidates: vi.fn(async () => []),
      reconcile: vi.fn(async () => ({ ok: true, applied: false })),
    };
    await runReconcilePending(deps);
    expect(withLock.mock.calls[0]![0]).toBe('tbank:reconcile-pending');
  });
});

// ---------------------------------------------------------------------------
// Секрет-гейт роута /api/cron/payments/[task]
// ---------------------------------------------------------------------------

describe('cron route /api/cron/payments/[task] — защита секретом', () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIG };
  });

  async function callPost(task: string, url: string): Promise<Response> {
    const { POST } = await import('@/app/api/cron/payments/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(url), { method: 'POST' });
    return POST(req, { params: Promise.resolve({ task }) });
  }

  it('без ключа → 401', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    const res = await callPost('reconcile-pending', 'http://localhost/api/cron/payments/reconcile-pending');
    expect(res.status).toBe(401);
  });

  it('неверный ключ → 401', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    const res = await callPost(
      'reconcile-pending',
      'http://localhost/api/cron/payments/reconcile-pending?key=wrong',
    );
    expect(res.status).toBe(401);
  });

  it('неизвестная задача → 404', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    const res = await callPost('bogus', 'http://localhost/api/cron/payments/bogus?key=s3cr3t');
    expect(res.status).toBe(404);
  });

  it('секрет не сконфигурирован → 503', async () => {
    delete process.env.CDEK_CRON_SECRET;
    const res = await callPost(
      'reconcile-pending',
      'http://localhost/api/cron/payments/reconcile-pending?key=anything',
    );
    expect(res.status).toBe(503);
  });

  it('верный ключ + модуль payments выключен → 200 skipped (no-op)', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    process.env.ADMIK_MODULES = 'catalog,orders'; // без payments
    const res = await callPost(
      'reconcile-pending',
      'http://localhost/api/cron/payments/reconcile-pending?key=s3cr3t',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped?: boolean; reason?: string };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('module_disabled');
  });
});
