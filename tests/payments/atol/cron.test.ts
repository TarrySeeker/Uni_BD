import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты крон-сверки платежей АТОЛ Pay (порт tests/payments/tbank/cron.test.ts).
 *
 * 🔴 Почему эти тесты важнее аналогов у других провайдеров: у callback АТОЛа нет
 * подписи, поэтому сверка — не страховка, а ОСНОВНОЙ путь подтверждения оплаты.
 * Дыра здесь означает либо неоплаченный заказ, помеченный оплаченным, либо
 * оплаченный заказ, навсегда застрявший в pending.
 *
 * (а) runAtolReconcilePending — с инъекцией deps (мок withLock/isMock/
 *     findCandidates/fetchStatus/applyStatus), без живой БД и сети (ADR-004);
 * (б) гейты роута /api/cron/payments/[task] для новой задачи.
 */

import {
  runAtolReconcilePending,
  RECONCILE_LOCK_KEY,
  type ReconcileDeps,
  type WithLock,
} from '@/lib/payments/atol/cron';
import { ATOL_PAYMENT_STATUS } from '@/lib/payments/atol/types';
import type { PendingAtolOrder } from '@/lib/payments/atol/repository';

const passLock: WithLock = async <T>(_key: string, fn: () => Promise<T>) => ({
  acquired: true as const,
  result: await fn(),
});
const failLock: WithLock = async () => ({ acquired: false as const });

/** Кандидат: заказ на 1000 ₽ с начатой, но не завершённой оплатой. */
function order(i: number, over: Partial<PendingAtolOrder> = {}): PendingAtolOrder {
  return {
    orderId: `ord-${i}`,
    orderNumber: `AT-${i}`,
    atolOrderId: `atol-${i}`,
    paymentStatus: 'pending',
    grandTotal: '1000.00',
    ...over,
  };
}

/** deps по умолчанию: боевой режим, лок свободен, ничего не найдено. */
function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    withLock: passLock,
    isMock: () => false,
    findCandidates: vi.fn(async () => []),
    fetchStatus: vi.fn(async () => ({ code: ATOL_PAYMENT_STATUS.processing, amountKop: 100000 })),
    applyStatus: vi.fn(async () => true),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// runAtolReconcilePending — воркер
// ---------------------------------------------------------------------------

describe('runAtolReconcilePending', () => {
  it('mock-режим → skipped, в сеть и в БД НЕ ходим', async () => {
    const findCandidates = vi.fn(async () => [order(0)]);
    const fetchStatus = vi.fn(async () => ({ code: 1, amountKop: 100000 }));
    const stats = await runAtolReconcilePending(
      deps({ isMock: () => true, findCandidates, fetchStatus }),
    );
    expect(stats).toEqual({ checked: 0, updated: 0, failed: 0, skipped: true });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('лок НЕ взят (параллельный прогон) → skipped, кандидаты не читаются', async () => {
    const findCandidates = vi.fn(async () => [order(0), order(1)]);
    const fetchStatus = vi.fn(async () => ({ code: 1, amountKop: 100000 }));
    const stats = await runAtolReconcilePending(
      deps({ withLock: failLock, findCandidates, fetchStatus }),
    );
    expect(stats).toEqual({ checked: 0, updated: 0, failed: 0, skipped: true });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('лок берётся по стабильному ключу atol:reconcile-pending', async () => {
    const withLock = vi.fn(async (_k: string, fn: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await fn(),
    }));
    await runAtolReconcilePending(deps({ withLock: withLock as unknown as WithLock }));
    expect(withLock.mock.calls[0]![0]).toBe(RECONCILE_LOCK_KEY);
    expect(RECONCILE_LOCK_KEY).toBe('atol:reconcile-pending');
  });

  it('статус 1 (успех) при сошедшейся сумме → заказ помечается оплаченным', async () => {
    const applyStatus = vi.fn(async () => true);
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0)]),
        fetchStatus: vi.fn(async () => ({
          code: ATOL_PAYMENT_STATUS.success,
          amountKop: 100000, // 1000.00 ₽ ровно
        })),
        applyStatus,
      }),
    );
    expect(stats).toEqual({ checked: 1, updated: 1, failed: 0, skipped: false });
    expect(applyStatus).toHaveBeenCalledTimes(1);
    const [orderId, to, comment] = applyStatus.mock.calls[0]! as unknown as [
      string,
      string,
      string,
    ];
    expect(orderId).toBe('ord-0');
    expect(to).toBe('paid');
    // Комментарий уходит в историю статусов — он должен быть читаемым оператором.
    expect(comment).toBe('АТОЛ: сверка — успех (выполнен)');
  });

  it('оплата подтверждена суммой БОЛЬШЕ заказа → засчитываем (переплата не наша проблема)', async () => {
    const applyStatus = vi.fn(async () => true);
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0)]),
        fetchStatus: vi.fn(async () => ({ code: ATOL_PAYMENT_STATUS.success, amountKop: 100001 })),
        applyStatus,
      }),
    );
    expect(stats.updated).toBe(1);
  });

  it('🔴 сумма из API МЕНЬШЕ суммы заказа → НЕ помечаем оплаченным, считаем ошибкой', async () => {
    const applyStatus = vi.fn(async () => true);
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0)]),
        fetchStatus: vi.fn(async () => ({
          code: ATOL_PAYMENT_STATUS.success,
          amountKop: 99999, // на копейку меньше 1000.00 ₽
        })),
        applyStatus,
      }),
    );
    expect(applyStatus).not.toHaveBeenCalled();
    expect(stats).toEqual({ checked: 1, updated: 0, failed: 1, skipped: false });
  });

  it('🔴 недоплата по одному заказу не мешает сверить остальные', async () => {
    const applyStatus = vi.fn(async () => true);
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0), order(1)]),
        fetchStatus: vi.fn(async (ref: string) => ({
          code: ATOL_PAYMENT_STATUS.success,
          amountKop: ref === 'atol-0' ? 1 : 100000,
        })),
        applyStatus,
      }),
    );
    expect(stats).toEqual({ checked: 2, updated: 1, failed: 1, skipped: false });
    expect(applyStatus).toHaveBeenCalledTimes(1);
    expect((applyStatus.mock.calls[0]! as unknown as [string])[0]).toBe('ord-1');
  });

  it('🔴 ошибка API по одному заказу → failed++, второй заказ всё равно обработан', async () => {
    const applyStatus = vi.fn(async () => true);
    const fetchStatus = vi.fn(async (ref: string) => {
      if (ref === 'atol-0') throw new Error('PAYMENT_NOT_FOUND');
      return { code: ATOL_PAYMENT_STATUS.success, amountKop: 100000 };
    });
    const stats = await runAtolReconcilePending(
      deps({ findCandidates: vi.fn(async () => [order(0), order(1)]), fetchStatus, applyStatus }),
    );
    expect(stats).toEqual({ checked: 1, updated: 1, failed: 1, skipped: false });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect((applyStatus.mock.calls[0]! as unknown as [string])[0]).toBe('ord-1');
  });

  it('ошибка применения статуса (БД) по одному заказу не валит прогон', async () => {
    const applyStatus = vi.fn(async (orderId: string) => {
      if (orderId === 'ord-0') throw new Error('db down');
      return true;
    });
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0), order(1)]),
        fetchStatus: vi.fn(async () => ({ code: ATOL_PAYMENT_STATUS.success, amountKop: 100000 })),
        applyStatus,
      }),
    );
    expect(stats).toEqual({ checked: 2, updated: 1, failed: 1, skipped: false });
  });

  it.each([
    ['частичная отмена (7)', ATOL_PAYMENT_STATUS.partialCancel],
    ['частичный возврат (8)', ATOL_PAYMENT_STATUS.partialRefund],
  ])(
    '🔴 %s → статус НЕ меняется (авто-refunded освободил бы весь резерв остатков)',
    async (_label, code) => {
      const applyStatus = vi.fn(async () => true);
      const stats = await runAtolReconcilePending(
        deps({
          findCandidates: vi.fn(async () => [order(0, { paymentStatus: 'paid' })]),
          fetchStatus: vi.fn(async () => ({ code, amountKop: 50000 })),
          applyStatus,
        }),
      );
      expect(applyStatus).not.toHaveBeenCalled();
      // Опросить заказ — не ошибка: исход просто не требует авто-перехода.
      expect(stats).toEqual({ checked: 1, updated: 0, failed: 0, skipped: false });
    },
  );

  it.each([
    ['банк не ответил (2)', ATOL_PAYMENT_STATUS.notResponding],
    ['ошибка, повтор возможен (12)', ATOL_PAYMENT_STATUS.retryError],
  ])('%s → статус НЕ меняется (исход неизвестен, резерв не отпускаем)', async (_l, code) => {
    const applyStatus = vi.fn(async () => true);
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0)]),
        fetchStatus: vi.fn(async () => ({ code, amountKop: 100000 })),
        applyStatus,
      }),
    );
    expect(applyStatus).not.toHaveBeenCalled();
    expect(stats.updated).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('статус совпал с текущим → applyStatus не дёргаем (лишняя запись в историю)', async () => {
    const applyStatus = vi.fn(async () => true);
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0, { paymentStatus: 'pending' })]),
        fetchStatus: vi.fn(async () => ({ code: ATOL_PAYMENT_STATUS.processing, amountKop: null })),
        applyStatus,
      }),
    );
    expect(applyStatus).not.toHaveBeenCalled();
    expect(stats).toEqual({ checked: 1, updated: 0, failed: 0, skipped: false });
  });

  it('applyStatus вернул false (переход отсечён статус-машиной/гардом) → updated не растёт', async () => {
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0)]),
        fetchStatus: vi.fn(async () => ({ code: ATOL_PAYMENT_STATUS.success, amountKop: 100000 })),
        applyStatus: vi.fn(async () => false),
      }),
    );
    expect(stats).toEqual({ checked: 1, updated: 0, failed: 0, skipped: false });
  });

  it('API не вернул сумму (amount отсутствует) → оплата засчитывается по статусу', async () => {
    // Сверять нечего: отсутствие поля не повод считать заказ недоплаченным,
    // иначе неполный ответ API заблокировал бы все подтверждения оплаты.
    const applyStatus = vi.fn(async () => true);
    const stats = await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [order(0)]),
        fetchStatus: vi.fn(async () => ({ code: ATOL_PAYMENT_STATUS.success, amountKop: null })),
        applyStatus,
      }),
    );
    expect(stats.updated).toBe(1);
  });

  it('возврат (5) → refunded; отказ (3) → failed', async () => {
    const applyStatus = vi.fn(async () => true);
    await runAtolReconcilePending(
      deps({
        findCandidates: vi.fn(async () => [
          order(0, { paymentStatus: 'paid' }),
          order(1, { paymentStatus: 'pending' }),
        ]),
        fetchStatus: vi.fn(async (ref: string) => ({
          code: ref === 'atol-0' ? ATOL_PAYMENT_STATUS.refunded : ATOL_PAYMENT_STATUS.error,
          amountKop: 100000,
        })),
        applyStatus,
      }),
    );
    const calls = applyStatus.mock.calls as unknown as Array<[string, string, string]>;
    expect(calls.map((c) => c[1])).toEqual(['refunded', 'failed']);
  });

  it('пустая выборка → нулевая статистика, в сеть не ходим', async () => {
    const fetchStatus = vi.fn(async () => ({ code: 1, amountKop: 100000 }));
    const stats = await runAtolReconcilePending(
      deps({ findCandidates: vi.fn(async () => []), fetchStatus }),
    );
    expect(stats).toEqual({ checked: 0, updated: 0, failed: 0, skipped: false });
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Гейты роута /api/cron/payments/atol-reconcile-pending
// ---------------------------------------------------------------------------

describe('cron route /api/cron/payments/atol-reconcile-pending — гейты', () => {
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
    const res = await callPost(
      'atol-reconcile-pending',
      'http://localhost/api/cron/payments/atol-reconcile-pending',
    );
    expect(res.status).toBe(401);
  });

  it('неизвестная задача → 404 (опечатка в имени не должна тихо ничего не делать)', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    const res = await callPost(
      'atol-reconcile',
      'http://localhost/api/cron/payments/atol-reconcile?key=s3cr3t',
    );
    expect(res.status).toBe(404);
  });

  it('верный ключ + модуль payments выключен → 200 skipped (no-op)', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    process.env.ADMIK_MODULES = 'catalog,orders'; // без payments
    const res = await callPost(
      'atol-reconcile-pending',
      'http://localhost/api/cron/payments/atol-reconcile-pending?key=s3cr3t',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped?: boolean; reason?: string };
    expect(body).toMatchObject({ ok: true, skipped: true, reason: 'module_disabled' });
  });
});
