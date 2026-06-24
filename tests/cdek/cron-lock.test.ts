import { describe, it, expect, vi } from 'vitest';

/**
 * Тесты СЕРИАЛИЗАЦИИ runCreatePending транзакционным advisory-lock
 * (анти-гонка, data-integrity).
 *
 * БАГ (major): при двойном срабатывании внешнего шедулера (или перекрытии
 * 5-мин тика) два прогона runCreatePending видели одни и те же кандидаты без
 * пометки/блокировки и оба POST-или в СДЭК → два реальных отправления на один
 * заказ. Фикс: весь прогон обёрнут в sql.begin и в начале берёт
 * pg_try_advisory_xact_lock(hashtext('cdek-create-pending')); если лок НЕ
 * получен — прогон завершается как skipped (lockSkipped), НЕ обрабатывая
 * кандидатов. Лок держится до конца транзакции (xact-lock), значит критическая
 * секция гарантированно одна на процесс/кластер.
 *
 * Логика лока проверяется юнитом на моке withLock (живой advisory-lock без БД
 * невозможен — он валидируется на стенде/CI, см. ОТЧЁТ). Здесь подменяем
 * withLock на детерминированную реализацию «получили / не получили».
 */

import {
  runCreatePending,
  type CreatePendingDeps,
  type PendingOrderCandidate,
  type WithLock,
} from '@/lib/cdek/cron';
import { getCdekConfig } from '@/lib/cdek/config';

const cfgEnabled = getCdekConfig({ NODE_ENV: 'test', CDEK_CREATE_ENABLED: 'true' });

function pending(n: number): PendingOrderCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ id: `ord-${i}`, number: `TC-${i}` }));
}

describe('runCreatePending — advisory-lock (сериализация прогонов)', () => {
  it('лок ПОЛУЧЕН → кандидаты обрабатываются (created), withLock вызван', async () => {
    const findCandidates = vi.fn(async () => pending(2));
    const createShipment = vi.fn(async (orderId: string) => ({ cdekUuid: `mock-${orderId}` }));
    // withLock(acquired=true): выполняет переданную критическую секцию.
    const withLock = vi.fn(async (_key: string, fn: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await fn(),
    }));

    const deps: CreatePendingDeps = {
      config: cfgEnabled,
      findCandidates,
      createShipment,
      withLock: withLock as unknown as WithLock,
    };
    const stats = await runCreatePending(deps);

    expect(withLock).toHaveBeenCalledOnce();
    expect(stats.created).toBe(2);
    expect(createShipment).toHaveBeenCalledTimes(2);
  });

  it('лок НЕ получен (параллельный прогон уже идёт) → skipped, кандидаты НЕ обрабатываются', async () => {
    const findCandidates = vi.fn(async () => pending(5));
    const createShipment = vi.fn(async (orderId: string) => ({ cdekUuid: `mock-${orderId}` }));
    // withLock(acquired=false): критическая секция НЕ выполняется.
    const withLock = vi.fn(async (_key: string, _fn: () => Promise<unknown>) => ({
      acquired: false as const,
    }));

    const deps: CreatePendingDeps = {
      config: cfgEnabled,
      findCandidates,
      createShipment,
      withLock: withLock as unknown as WithLock,
    };
    const stats = await runCreatePending(deps);

    // Главное: никаких удалённых вызовов create — конкурентный прогон не дублирует СДЭК.
    expect(createShipment).not.toHaveBeenCalled();
    // findCandidates тоже не должен дёргаться вне критической секции (нечего считать).
    expect(findCandidates).not.toHaveBeenCalled();
    expect(stats).toEqual({ created: 0, failed: 0, skipped: 0, lockSkipped: true });
  });

  it('лок берётся по стабильному ключу cdek-create-pending', async () => {
    const withLock = vi.fn(async (_key: string, fn: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await fn(),
    }));
    const deps: CreatePendingDeps = {
      config: cfgEnabled,
      findCandidates: vi.fn(async () => []),
      createShipment: vi.fn(async () => ({ cdekUuid: 'x' })),
      withLock: withLock as unknown as WithLock,
    };
    await runCreatePending(deps);
    expect(withLock.mock.calls[0]![0]).toBe('cdek-create-pending');
  });

  it('kill-switch (CDEK_CREATE_ENABLED=false) → лок не берётся, кандидаты skipped', async () => {
    const cfgDisabled = getCdekConfig({ NODE_ENV: 'test', CDEK_CREATE_ENABLED: 'false' });
    const withLock = vi.fn();
    const deps: CreatePendingDeps = {
      config: cfgDisabled,
      findCandidates: vi.fn(async () => pending(3)),
      createShipment: vi.fn(async () => ({ cdekUuid: 'x' })),
      withLock: withLock as unknown as WithLock,
    };
    const stats = await runCreatePending(deps);
    expect(withLock).not.toHaveBeenCalled();
    expect(stats).toEqual({ created: 0, failed: 0, skipped: 3, lockSkipped: false });
  });
});
