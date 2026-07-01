import { describe, it, expect, afterEach } from 'vitest';

import {
  mergeSettings,
  isSingleUserMode,
  isSingleUserModeEnabled,
  invalidateSettingsCache,
} from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';
import type { SettingRow } from '@/lib/settings/repository';

/**
 * Однопользовательский режим (B9): per-shop access-флаг с дефолтом OFF.
 *
 * Мерж: ключ `access` в shop_settings; отсутствие/пустой объект → singleUserMode
 * false (мультитенантность — другие магазины не затронуты). isSingleUserMode —
 * чистая проверка по эффективным настройкам; isSingleUserModeEnabled — async-
 * обёртка над getEffectiveSettings (тот же memo-кэш).
 */

function env() {
  return getEnv({ NODE_ENV: 'test', SHOP_NAME: 'EnvShop', SHOP_CURRENCY: 'RUB' });
}

afterEach(() => {
  invalidateSettingsCache();
});

describe('config/settings — access.singleUserMode (merge)', () => {
  it('пустая БД → singleUserMode false (дефолт OFF)', () => {
    const eff = mergeSettings(env(), []);
    expect(eff.access.singleUserMode).toBe(false);
    expect(isSingleUserMode(eff)).toBe(false);
  });

  it('пустой объект {} → singleUserMode false (нет оверрайда)', () => {
    const eff = mergeSettings(env(), [{ setting_key: 'access', value: {} }]);
    expect(eff.access.singleUserMode).toBe(false);
  });

  it('access.singleUserMode=true → режим включён', () => {
    const eff = mergeSettings(env(), [
      { setting_key: 'access', value: { singleUserMode: true } },
    ]);
    expect(eff.access.singleUserMode).toBe(true);
    expect(isSingleUserMode(eff)).toBe(true);
  });

  it('кривое значение access → дефолт false (merge не падает)', () => {
    const eff = mergeSettings(env(), [
      { setting_key: 'access', value: { singleUserMode: 'oops' } as never },
    ]);
    expect(eff.access.singleUserMode).toBe(false);
  });
});

describe('config/settings — isSingleUserModeEnabled (async)', () => {
  it('БД без access → false', async () => {
    const readRows = async (): Promise<SettingRow[]> => [];
    expect(await isSingleUserModeEnabled({ readRows, env: env() })).toBe(false);
  });

  it('БД с access.singleUserMode=true → true', async () => {
    const readRows = async (): Promise<SettingRow[]> => [
      { setting_key: 'access', value: { singleUserMode: true } },
    ];
    expect(await isSingleUserModeEnabled({ readRows, env: env() })).toBe(true);
  });

  it('ошибка чтения БД → false (graceful: не блокируем при недоступной БД)', async () => {
    const readRows = async (): Promise<SettingRow[]> => {
      throw new Error('db down');
    };
    expect(await isSingleUserModeEnabled({ readRows, env: env() })).toBe(false);
  });
});
