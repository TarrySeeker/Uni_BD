import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Тесты cron-сверки платежей Т-Банка (Фича #16, порт tests/cdek/cron*.test.ts).
 *
 * (а) runReconcilePending — с инъекцией deps (мок findCandidates/reconcile/withLock),
 *     без живой БД и сети: статистика checked/advanced/failed, lockSkipped при занятом
 *     advisory-lock, устойчивость (исключение по одному заказу не валит прогон).
 * (б) Секрет-гейт роута /api/cron/payments/[task]: нет секрета → 503, неверный ключ →
 *     401, неизвестная задача → 404, верный ключ + модуль payments выключен → 200 skipped.
 * (в) Диспетчеризация роута по эквайерам: задача каждого адаптера дёргает СВОЙ воркер,
 *     и у каждого адаптера с lib/payments/<adapter>/cron.ts есть задача в TASKS. Без
 *     этого воркер существует, но не вызывается — оплаты эквайера висят в pending.
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

// ---------------------------------------------------------------------------
// Диспетчеризация роута по эквайерам: у КАЖДОГО адаптера с cron-воркером должна
// быть своя задача сверки. Пропущенная задача = «зависшие» оплаты этого эквайера
// никогда не досверяются (деньги списаны, заказ остался pending).
// ---------------------------------------------------------------------------

describe('cron route /api/cron/payments/[task] — диспетчеризация по эквайерам', () => {
  const ORIG = { ...process.env };
  const SECRET = 's3cr3t';

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIG };
    process.env.CDEK_CRON_SECRET = SECRET;
    vi.doMock('@/lib/config/settings', () => ({
      isModuleEffectivelyEnabled: async () => true,
    }));
  });

  afterEach(() => {
    process.env = { ...ORIG };
    vi.resetModules();
    vi.doUnmock('@/lib/config/settings');
    vi.doUnmock('@/lib/payments/tbank/cron');
    vi.doUnmock('@/lib/payments/paykeeper/cron');
    vi.doUnmock('@/lib/payments/alfabank/cron');
  });

  function emptyStats() {
    return { checked: 0, advanced: 0, failed: 0, lockSkipped: false };
  }

  /** Мокает всех трёх воркеров и возвращает шпионы. */
  function mockWorkers() {
    const tbank = vi.fn(async () => emptyStats());
    const paykeeper = vi.fn(async () => emptyStats());
    const alfabank = vi.fn(async () => emptyStats());
    vi.doMock('@/lib/payments/tbank/cron', () => ({ runReconcilePending: tbank }));
    vi.doMock('@/lib/payments/paykeeper/cron', () => ({ runReconcilePending: paykeeper }));
    vi.doMock('@/lib/payments/alfabank/cron', () => ({ runReconcilePending: alfabank }));
    return { tbank, paykeeper, alfabank };
  }

  async function callPost(task: string): Promise<Response> {
    const { POST } = await import('@/app/api/cron/payments/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(`http://localhost/api/cron/payments/${task}?key=${SECRET}`), {
      method: 'POST',
    });
    return POST(req, { params: Promise.resolve({ task }) });
  }

  it('reconcile-pending → воркер Т-Банка (и только он)', async () => {
    const w = mockWorkers();
    const res = await callPost('reconcile-pending');
    expect(res.status).toBe(200);
    expect(w.tbank).toHaveBeenCalledTimes(1);
    expect(w.paykeeper).not.toHaveBeenCalled();
    expect(w.alfabank).not.toHaveBeenCalled();
  });

  it('reconcile-pending-paykeeper → воркер PayKeeper (и только он)', async () => {
    const w = mockWorkers();
    const res = await callPost('reconcile-pending-paykeeper');
    expect(res.status).toBe(200);
    expect(w.paykeeper).toHaveBeenCalledTimes(1);
    expect(w.tbank).not.toHaveBeenCalled();
    expect(w.alfabank).not.toHaveBeenCalled();
  });

  it('reconcile-pending-alfabank → воркер Альфа-Банка (и только он)', async () => {
    const w = mockWorkers();
    const res = await callPost('reconcile-pending-alfabank');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; task: string };
    expect(body.ok).toBe(true);
    expect(body.task).toBe('reconcile-pending-alfabank');
    expect(w.alfabank).toHaveBeenCalledTimes(1);
    expect(w.tbank).not.toHaveBeenCalled();
    expect(w.paykeeper).not.toHaveBeenCalled();
  });

  it('у каждого адаптера с cron-воркером есть задача сверки в роуте', () => {
    const ROOT = process.cwd();
    // Адаптеры с файлом cron.ts (= есть что сверять по расписанию).
    const withWorker = readdirSync(join(ROOT, 'lib/payments'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(ROOT, 'lib/payments', name, 'cron.ts')));
    expect(withWorker.length).toBeGreaterThan(1);

    const route = readFileSync(join(ROOT, 'app/api/cron/payments/[task]/route.ts'), 'utf8');
    const tasks = /const TASKS = \[([^\]]+)\]/.exec(route)?.[1] ?? '';
    const declared = [...tasks.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

    for (const adapter of withWorker) {
      // tbank — исторически базовая задача без суффикса.
      const expected = adapter === 'tbank' ? 'reconcile-pending' : `reconcile-pending-${adapter}`;
      expect(declared, `нет задачи сверки для адаптера ${adapter}`).toContain(expected);
    }
  });
});
