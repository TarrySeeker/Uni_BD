import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты cron-воркеров СДЭК (docs/08 §9, Пакет G).
 *
 * (а) Воркеры (runCreatePending / runRefreshActive / runNotifyStuck) — с
 *     инъецированными deps (мок поиска кандидатов + мок сервисов), без живой БД и
 *     сети. Проверяем статистику, kill-switch CDEK_CREATE_ENABLED=false,
 *     устойчивость (ошибка одного заказа не валит прогон), счёт зависших.
 * (б) Секрет-гейт роута [task] — без ключа → 401, неизвестная задача → 404,
 *     несконфигурированный секрет → 503, верный ключ + выключенный модуль →
 *     200 skipped. БД не требуется (до запуска воркера не доходит).
 */

import {
  runCreatePending,
  runRefreshActive,
  runNotifyStuck,
  type CreatePendingDeps,
  type RefreshActiveDeps,
  type NotifyStuckDeps,
  type PendingOrderCandidate,
  type ActiveShipmentCandidate,
  type StuckOrderCandidate,
} from '@/lib/cdek/cron';
import { getCdekConfig } from '@/lib/cdek/config';

const cfgEnabled = getCdekConfig({ NODE_ENV: 'test', CDEK_CREATE_ENABLED: 'true' });
const cfgDisabled = getCdekConfig({ NODE_ENV: 'test', CDEK_CREATE_ENABLED: 'false' });

/**
 * withLock-заглушка «лок получен»: выполняет критическую секцию (advisory-lock
 * проверяется отдельно в tests/cdek/cron-lock.test.ts — здесь интересна сама
 * обработка кандидатов). Возвращает { acquired:true, result }.
 */
const passLock = async <T>(_key: string, fn: () => Promise<T>) => ({
  acquired: true as const,
  result: await fn(),
});

function pending(n: number): PendingOrderCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ id: `ord-${i}`, number: `TC-${i}` }));
}
function active(n: number): ActiveShipmentCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ orderId: `ord-${i}`, cdekUuid: `uuid-${i}` }));
}
function stuck(n: number): StuckOrderCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ord-${i}`,
    number: `TC-${i}`,
    customerName: `Покупатель ${i}`,
    customerPhone: null,
    customerEmail: null,
    error: 'cdek error',
  }));
}

// ---------------------------------------------------------------------------
// runCreatePending
// ---------------------------------------------------------------------------

describe('runCreatePending', () => {
  it('создаёт отправления по всем кандидатам и считает created', async () => {
    const deps: CreatePendingDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => pending(3)),
      createShipment: vi.fn(async (orderId: string) => ({ cdekUuid: `mock-${orderId}` })),
      withLock: passLock,
    };
    const stats = await runCreatePending(deps);
    expect(stats).toEqual({ created: 3, failed: 0, skipped: 0, lockSkipped: false });
    expect(deps.createShipment).toHaveBeenCalledTimes(3);
  });

  it('при CDEK_CREATE_ENABLED=false ничего не создаёт (kill-switch), кандидаты → skipped', async () => {
    const createShipment = vi.fn(async () => ({ cdekUuid: 'x' }));
    const deps: CreatePendingDeps = {
      config: cfgDisabled,
      findCandidates: vi.fn(async () => pending(2)),
      createShipment,
      withLock: passLock,
    };
    const stats = await runCreatePending(deps);
    expect(stats).toEqual({ created: 0, failed: 0, skipped: 2, lockSkipped: false });
    expect(createShipment).not.toHaveBeenCalled();
  });

  it('ошибка по одному заказу не валит весь прогон (failed++, остальные created)', async () => {
    const deps: CreatePendingDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => pending(3)),
      createShipment: vi.fn(async (orderId: string) => {
        if (orderId === 'ord-1') throw new Error('cdek boom');
        return { cdekUuid: `mock-${orderId}` };
      }),
      withLock: passLock,
    };
    const stats = await runCreatePending(deps);
    expect(stats).toEqual({ created: 2, failed: 1, skipped: 0, lockSkipped: false });
  });

  it('отправление без cdekUuid считается skipped, не падает', async () => {
    const deps: CreatePendingDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => pending(2)),
      createShipment: vi.fn(async () => ({ cdekUuid: null })),
      withLock: passLock,
    };
    const stats = await runCreatePending(deps);
    expect(stats).toEqual({ created: 0, failed: 0, skipped: 2, lockSkipped: false });
  });

  it('идемпотентность: пустой список кандидатов → нулевая статистика, без вызовов', async () => {
    const createShipment = vi.fn(async () => ({ cdekUuid: 'x' }));
    const deps: CreatePendingDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => []),
      createShipment,
      withLock: passLock,
    };
    const stats = await runCreatePending(deps);
    expect(stats).toEqual({ created: 0, failed: 0, skipped: 0, lockSkipped: false });
    expect(createShipment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runRefreshActive
// ---------------------------------------------------------------------------

describe('runRefreshActive', () => {
  it('обновляет статусы активных, считает refreshed/transitioned', async () => {
    const deps: RefreshActiveDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => active(3)),
      refreshStatus: vi.fn(async (orderId: string) => ({ transitioned: orderId === 'ord-0' })),
    };
    const stats = await runRefreshActive(deps);
    expect(stats).toEqual({ refreshed: 3, transitioned: 1, failed: 0 });
  });

  it('ошибка одного отправления не валит прогон', async () => {
    const deps: RefreshActiveDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => active(2)),
      refreshStatus: vi.fn(async (orderId: string) => {
        if (orderId === 'ord-0') throw new Error('network');
        return { transitioned: false };
      }),
    };
    const stats = await runRefreshActive(deps);
    expect(stats).toEqual({ refreshed: 1, transitioned: 0, failed: 1 });
  });
});

// ---------------------------------------------------------------------------
// runNotifyStuck
// ---------------------------------------------------------------------------

describe('runNotifyStuck', () => {
  it('считает зависшие и вызывает notify hook', async () => {
    const notify = vi.fn(async () => undefined);
    const deps: NotifyStuckDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => stuck(4)),
      notify,
    };
    const stats = await runNotifyStuck(deps);
    expect(stats).toEqual({ stuck: 4 });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ number: 'TC-0' })]));
  });

  it('пустой список → notify не вызывается, stuck=0 (идемпотентно)', async () => {
    const notify = vi.fn(async () => undefined);
    const deps: NotifyStuckDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => []),
      notify,
    };
    const stats = await runNotifyStuck(deps);
    expect(stats).toEqual({ stuck: 0 });
    expect(notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Секрет-гейт роута /api/cron/cdek/[task]
// ---------------------------------------------------------------------------

describe('cron route [task] — защита секретом', () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIG };
  });

  async function callPost(task: string, url: string): Promise<Response> {
    const { POST } = await import('@/app/api/cron/cdek/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(url), { method: 'POST' });
    return POST(req, { params: Promise.resolve({ task }) });
  }

  it('без ключа → 401', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    const res = await callPost('create-pending', 'http://localhost/api/cron/cdek/create-pending');
    expect(res.status).toBe(401);
  });

  it('неверный ключ → 401', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    const res = await callPost(
      'create-pending',
      'http://localhost/api/cron/cdek/create-pending?key=wrong',
    );
    expect(res.status).toBe(401);
  });

  it('неизвестная задача → 404', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    const res = await callPost('bogus', 'http://localhost/api/cron/cdek/bogus?key=s3cr3t');
    expect(res.status).toBe(404);
  });

  it('секрет не сконфигурирован → 503', async () => {
    delete process.env.CDEK_CRON_SECRET;
    const res = await callPost(
      'create-pending',
      'http://localhost/api/cron/cdek/create-pending?key=anything',
    );
    expect(res.status).toBe(503);
  });

  it('верный ключ + модуль cdek выключен → 200 skipped (no-op)', async () => {
    process.env.CDEK_CRON_SECRET = 's3cr3t';
    process.env.ADMIK_MODULES = 'catalog,orders'; // без cdek
    const res = await callPost(
      'create-pending',
      'http://localhost/api/cron/cdek/create-pending?key=s3cr3t',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped?: boolean };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
  });
});
