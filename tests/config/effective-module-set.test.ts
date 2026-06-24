import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getEffectiveModuleSet,
  isModuleEffectivelyEnabled,
  invalidateSettingsCache,
  mergeSettings,
} from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';
import { getEnabledModules, ALL_MODULES } from '@/lib/config/modules';

/**
 * Тесты АВТОРИТЕТНОГО рантайм-гейта модулей (баг #1 волны 5).
 *
 * До фикса updateModuleOverrides писал module_overrides в БД, но единственным
 * потребителем getEffectiveModules был sitemap — все рантайм-гейты читали только
 * env (синхронный isModuleEnabled), игнорируя БД-оверрайд. Эти тесты фиксируют,
 * что getEffectiveModuleSet/isModuleEffectivelyEnabled УЧИТЫВАЮТ module_overrides
 * из настроек (через инъекцию readRows, без БД) и при этом БЕЗ оверрайда дают
 * ровно env-поведение (обратная совместимость).
 */

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({ NODE_ENV: 'test', ...overrides });
}

afterEach(() => {
  invalidateSettingsCache();
});

describe('config/settings — mergeSettings несёт module_overrides', () => {
  it('строка module_overrides в БД попадает в eff.modules.overrides', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'module_overrides', value: { catalog: false, payments: true } },
    ]);
    expect(eff.modules.overrides).toEqual({ catalog: false, payments: true });
  });

  it('пустая БД → eff.modules.overrides === {} (нет оверрайда)', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.modules.overrides).toEqual({});
  });

  it('неизвестные ключи в module_overrides отбрасываются (.strip)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'module_overrides', value: { settings: false, hacker: true, cms: false } },
    ]);
    // 'settings'/'hacker' не входят в схему → отброшены; остаётся только cms.
    expect(eff.modules.overrides).toEqual({ cms: false });
  });
});

describe('config/settings — getEffectiveModuleSet (env ⊕ БД-оверрайд)', () => {
  it('module_overrides={catalog:false} → набор НЕ содержит catalog', async () => {
    const readRows = vi.fn(async () => [
      { setting_key: 'module_overrides', value: { catalog: false } },
    ]);
    const set = await getEffectiveModuleSet({ readRows, env: envWith() });
    expect(set.has('catalog')).toBe(false);
    // Остальные модули (env=all по умолчанию) остаются включены.
    expect(set.has('orders')).toBe(true);
    expect(set.has('cms')).toBe(true);
  });

  it('isModuleEffectivelyEnabled(catalog) === false при оверрайде catalog:false', async () => {
    const readRows = vi.fn(async () => [
      { setting_key: 'module_overrides', value: { catalog: false } },
    ]);
    await expect(
      isModuleEffectivelyEnabled('catalog', { readRows, env: envWith() }),
    ).resolves.toBe(false);
  });

  it('оверрайд может ВКЛЮЧИТЬ модуль, отсутствующий в env-наборе', async () => {
    const readRows = vi.fn(async () => [
      { setting_key: 'module_overrides', value: { cms: true } },
    ]);
    const env = envWith({ ADMIK_MODULES: 'catalog' });
    const set = await getEffectiveModuleSet({ readRows, env });
    expect(set.has('cms')).toBe(true);
    expect(set.has('catalog')).toBe(true);
    expect(set.has('orders')).toBe(false);
  });

  it('payments тоже управляем оверрайдом (payments:false выключает)', async () => {
    const readRows = vi.fn(async () => [
      { setting_key: 'module_overrides', value: { payments: false } },
    ]);
    const set = await getEffectiveModuleSet({ readRows, env: envWith() });
    expect(set.has('payments')).toBe(false);
  });
});

describe('config/settings — обратная совместимость (БЕЗ оверрайда === env)', () => {
  it('пустой module_overrides → набор === getEnabledModules(env)', async () => {
    const readRows = vi.fn(async () => [{ setting_key: 'module_overrides', value: {} }]);
    const env = envWith({ ADMIK_MODULES: 'catalog,orders' });
    const set = await getEffectiveModuleSet({ readRows, env });
    expect([...set].sort()).toEqual(getEnabledModules({ ADMIK_MODULES: env.ADMIK_MODULES }).sort());
  });

  it('отсутствие строки module_overrides → набор === getEnabledModules(env)', async () => {
    const readRows = vi.fn(async () => []);
    const env = envWith({ ADMIK_MODULES: 'orders,cdek' });
    const set = await getEffectiveModuleSet({ readRows, env });
    expect([...set].sort()).toEqual(getEnabledModules({ ADMIK_MODULES: env.ADMIK_MODULES }).sort());
  });

  it('env не задан + нет оверрайда → все модули (как env-дефолт)', async () => {
    const readRows = vi.fn(async () => []);
    const env = envWith({ ADMIK_MODULES: undefined });
    const set = await getEffectiveModuleSet({ readRows, env });
    expect([...set].sort()).toEqual([...ALL_MODULES].sort());
  });

  it('чтение БД упало (reader бросает) → мягкий откат на env-набор', async () => {
    const readRows = vi.fn(async () => {
      throw new Error('DATABASE_URL не задан');
    });
    const env = envWith({ ADMIK_MODULES: 'catalog' });
    const set = await getEffectiveModuleSet({ readRows, env });
    // Без БД авторитетен env: только catalog.
    expect([...set].sort()).toEqual(['catalog']);
  });
});
