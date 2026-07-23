import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { createSettingsActions, type SettingsActionDeps } from '@/lib/settings/action-factory';
import type { UpdateRatesStats } from '@/lib/exchange/cron';

/**
 * C3. ВОЗВРАТ ВАЛЮТЫ НА АВТОКУРС ОДНИМ ДЕЙСТВИЕМ.
 *
 * Сняв признак «курс задан вручную», владелец не должен ждать ночного крона:
 * из админки доступен ручной запуск обновления курсов. Права — settings.manage,
 * как у прочих настроек (действие НЕ обходит защиту cron-роута секретом).
 *
 * Плюс C2: прод-зависимости воркера обязаны передавать readBaseCurrency — иначе
 * гейт «база не RUB» жил бы ТОЛЬКО в HTTP-роуте, и ручной запуск (как и любой
 * другой вызов воркера) писал бы курсы ЦБ на не-рублёвый магазин.
 */

function makeUser(perms: PermissionCode[]): AuthUser {
  return { id: 'u-1', email: 'a@b.c', isOwner: false, permissions: new Set(perms) };
}

function makeActionDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

function makeDeps(
  actionDeps: ActionDeps,
  runExchangeUpdate: () => Promise<UpdateRatesStats>,
): SettingsActionDeps {
  return {
    actionDeps,
    upsertSetting: vi.fn(),
    deleteSetting: vi.fn(),
    getSetting: vi.fn(async () => null),
    invalidateCache: vi.fn(() => {}),
    hasPublishedCmsPages: vi.fn(async () => false),
    validateUpload: vi.fn(),
    generatePreviews: vi.fn(),
    getStorage: vi.fn(),
    runExchangeUpdate,
  } as unknown as SettingsActionDeps;
}

const OK: UpdateRatesStats = { ok: true, updated: 1, missing: [], skipped: ['USD'] };

describe('refreshExchangeRates — ручной запуск обновления курсов', () => {
  it('без права settings.manage → forbidden, прогон не запускается', async () => {
    const run = vi.fn(async () => OK);
    const { refreshExchangeRates } = createSettingsActions(
      makeDeps(makeActionDeps(makeUser(['catalog.read'])), run),
    );
    const res = await refreshExchangeRates({});
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(run).not.toHaveBeenCalled();
  });

  it('без сессии → unauthorized', async () => {
    const run = vi.fn(async () => OK);
    const { refreshExchangeRates } = createSettingsActions(
      makeDeps(makeActionDeps(null), run),
    );
    expect(await refreshExchangeRates({})).toEqual({ ok: false, error: 'unauthorized' });
    expect(run).not.toHaveBeenCalled();
  });

  it('с правом → прогон запущен, статистика отдана, кеш сброшен', async () => {
    const run = vi.fn(async () => OK);
    const deps = makeDeps(makeActionDeps(makeUser(['settings.manage'])), run);
    const { refreshExchangeRates } = createSettingsActions(deps);

    const res = await refreshExchangeRates({});

    expect(res.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    // Ручные валюты крон/ручной запуск не трогают — это видно в статистике.
    expect(res.ok && res.data).toMatchObject({ updated: 1, skipped: ['USD'] });
    expect(deps.invalidateCache).toHaveBeenCalled();
  });

  it('пишет событие аудита (кто и когда трогал курсы)', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const { refreshExchangeRates } = createSettingsActions(makeDeps(actionDeps, async () => OK));
    await refreshExchangeRates({});
    const entry = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.action).toBe('settings.exchange.refresh');
    expect(entry.entityId).toBe('exchange');
  });

  it('источник ЦБ недоступен → понятная ошибка, а не «успешно»', async () => {
    const { refreshExchangeRates } = createSettingsActions(
      makeDeps(makeActionDeps(makeUser(['settings.manage'])), async () => ({
        ok: false,
        updated: 0,
        missing: [],
        skipped: [],
        reason: 'fetch_failed' as const,
      })),
    );
    const res = await refreshExchangeRates({});
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).not.toBe('unauthorized');
  });
});

describe('C2: прод-зависимости воркера курсов', () => {
  const service = readFileSync(
    resolve(__dirname, '../../lib/exchange/service.ts'),
    'utf8',
  );

  it('productionExchangeDeps передаёт readBaseCurrency (гейт не только в HTTP-роуте)', () => {
    expect(service).toContain('readBaseCurrency:');
  });

  it('перед записью читается СВЕЖИЙ снимок настроек (гонка read-modify-write)', () => {
    expect(service).toContain('mergeCronRates');
    expect(service).toMatch(/const latest = await readExchangeFromDb\(\)/);
  });
});
