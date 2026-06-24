import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  createSettingsActions,
  ModuleOverridesInputSchema,
  type SettingsActionDeps,
} from '@/lib/settings/action-factory';
import { buildAdminNav } from '@/lib/admin/nav';
import { legalEntitySchema } from '@/lib/settings/schemas';
import { ALL_MODULES, getEnabledModules } from '@/lib/config/modules';

/**
 * Тесты пакета 5.D-2 (docs/11 §5.4.6) — Server Actions настроек магазина.
 *
 * Все мутации — через defineAction({permission:'settings.manage'}). Тестируем без
 * БД/Next: репозиторий, инвалидация кеша и data-чекеры инъецируются через
 * SettingsActionDeps; user/audit/revalidate — через ActionDeps. Проверяем:
 *   - guard (forbidden без права, успех с правом/owner);
 *   - валидацию (невалидный модуль/logoUrl/hex → validation);
 *   - upsert + audit (before/after) + revalidate;
 *   - updateModuleOverrides: self-lock (settings всегда в навигации),
 *     warnings при выключении cms с опубликованными страницами;
 *   - resetSetting → delete.
 */

// -----------------------------------------------------------------------------
// Хелперы.
// -----------------------------------------------------------------------------

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return {
    id: 'u-1',
    email: 'admin@shop.io',
    isOwner,
    permissions: new Set<PermissionCode>(perms),
  };
}

function makeActionDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

/** Собирает settings-deps с моками репозитория/кеша/чекеров. */
function makeSettingsDeps(
  actionDeps: ActionDeps,
  overrides: Partial<SettingsActionDeps> = {},
): SettingsActionDeps {
  return {
    actionDeps,
    upsertSetting: vi.fn(async (key: string, value: Record<string, unknown>) => ({
      setting_key: key,
      value,
      updated_at: new Date('2026-06-15T00:00:00Z'),
      updated_by: 'u-1',
    })),
    deleteSetting: vi.fn(async () => true),
    getSetting: vi.fn(async () => null),
    invalidateCache: vi.fn(() => {}),
    hasPublishedCmsPages: vi.fn(async () => false),
    validateUpload: vi.fn(async () => ({ ok: true, mime: 'image/webp' as const })),
    generatePreviews: vi.fn(async () => ({
      main: { buffer: Buffer.from('webp'), width: 1, height: 1, format: 'webp' },
      thumbnail: { buffer: Buffer.from('webp'), width: 1, height: 1, format: 'webp' },
    })),
    getStorage: vi.fn(),
    ...overrides,
  };
}

// =============================================================================
// Гвард и валидация (общий пайплайн defineAction).
// =============================================================================
describe('settings/actions — guard settings.manage', () => {
  it('не аутентифицирован → unauthorized, репозиторий не тронут', async () => {
    const actionDeps = makeActionDeps(null);
    const deps = makeSettingsDeps(actionDeps);
    const { updateBrandingSettings } = createSettingsActions(deps);
    const res = await updateBrandingSettings({ branding: { shopName: 'X' } });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('без settings.manage → forbidden', async () => {
    const actionDeps = makeActionDeps(makeUser(['catalog.write']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateModuleOverrides } = createSettingsActions(deps);
    const res = await updateModuleOverrides({ moduleOverrides: { cms: false } });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('owner проходит без явного права', async () => {
    const actionDeps = makeActionDeps(makeUser([], true));
    const deps = makeSettingsDeps(actionDeps);
    const { updateBrandingSettings } = createSettingsActions(deps);
    const res = await updateBrandingSettings({ branding: { shopName: 'X' } });
    expect(res.ok).toBe(true);
  });
});

// =============================================================================
// updateBrandingSettings.
// =============================================================================
describe('settings/actions — updateBrandingSettings', () => {
  it('невалидный logoUrl → validation, репозиторий не тронут', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateBrandingSettings } = createSettingsActions(deps);
    const res = await updateBrandingSettings({ branding: { logoUrl: 'not-a-url' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('невалидный hex-цвет темы → validation', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateBrandingSettings } = createSettingsActions(deps);
    const res = await updateBrandingSettings({
      branding: { theme: { primaryColor: 'red' } },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });

  it('успех: upsert ключа branding + updated_by + audit + invalidate', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateBrandingSettings } = createSettingsActions(deps);
    const res = await updateBrandingSettings({
      branding: { shopName: 'Gang Auto', theme: { primaryColor: '#ff0000' } },
    });
    expect(res.ok).toBe(true);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'branding',
      expect.objectContaining({ shopName: 'Gang Auto' }),
      'u-1',
    );
    expect(deps.invalidateCache).toHaveBeenCalled();
    expect(actionDeps.writeAudit).toHaveBeenCalledTimes(1);
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.branding.update');
  });
});

// =============================================================================
// updateCurrencyAndUnits / updateLegalAndContacts.
// =============================================================================
describe('settings/actions — currency/units и legal/contacts', () => {
  it('updateCurrencyAndUnits: апсертит currency и units', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateCurrencyAndUnits } = createSettingsActions(deps);
    const res = await updateCurrencyAndUnits({
      currency: { code: 'USD' },
      units: { weight: 'kg' },
    });
    expect(res.ok).toBe(true);
    const keys = (deps.upsertSetting as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(keys).toContain('currency');
    expect(keys).toContain('units');
  });

  it('updateLegalAndContacts: невалидный ИНН → validation', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateLegalAndContacts } = createSettingsActions(deps);
    const res = await updateLegalAndContacts({ legalEntity: { inn: '123' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });

  it('updateLegalAndContacts: валидный ИНН 10/12 → успех', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateLegalAndContacts } = createSettingsActions(deps);
    const res10 = await updateLegalAndContacts({ legalEntity: { inn: '7701234567' } });
    expect(res10.ok).toBe(true);
    const res12 = await updateLegalAndContacts({ legalEntity: { inn: '770123456789' } });
    expect(res12.ok).toBe(true);
  });
});

// =============================================================================
// updateCatalogOrdersSettings — freeDeliveryThreshold рубли → копейки.
// =============================================================================
describe('settings/actions — updateCatalogOrdersSettings (деньги)', () => {
  it('freeDeliveryThreshold вводится в рублях → хранится в копейках (toMinor)', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateCatalogOrdersSettings } = createSettingsActions(deps);
    const res = await updateCatalogOrdersSettings({
      catalog: { newProductDays: 7 },
      delivery: { freeDeliveryThreshold: '3000.00' },
      orders: { orderPrefix: 'GA' },
    });
    expect(res.ok).toBe(true);
    const deliveryCall = (deps.upsertSetting as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'delivery',
    );
    expect(deliveryCall).toBeDefined();
    // 3000 руб → 300000 копеек (int, без float).
    expect(deliveryCall![1]).toEqual({ freeDeliveryThreshold: 300000 });
    expect(Number.isInteger((deliveryCall![1] as { freeDeliveryThreshold: number }).freeDeliveryThreshold)).toBe(true);
  });

  it('freeDeliveryThreshold невалидное число → validation', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateCatalogOrdersSettings } = createSettingsActions(deps);
    const res = await updateCatalogOrdersSettings({
      delivery: { freeDeliveryThreshold: 'abc' },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });
});

// =============================================================================
// updateModuleOverrides.
// =============================================================================
describe('settings/actions — updateModuleOverrides', () => {
  it('невалидный модуль (не из схемы) → validation', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateModuleOverrides } = createSettingsActions(deps);
    const res = await updateModuleOverrides({
      moduleOverrides: { settings: false } as unknown as Record<string, boolean>,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });

  it('успех: upsert module_overrides + audit + revalidate всех /admin', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateModuleOverrides } = createSettingsActions(deps);
    const res = await updateModuleOverrides({ moduleOverrides: { orders: false } });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    // нет активных данных → нет предупреждений.
    expect(res.data.warnings).toEqual([]);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'module_overrides',
      { orders: false },
      'u-1',
    );
    const revalidated = (actionDeps.revalidate as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(revalidated).toContain('/admin');
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.modules.update');
  });

  it('выключение cms при опубликованных страницах → success + warnings (не блок)', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps, {
      hasPublishedCmsPages: vi.fn(async () => true),
    });
    const { updateModuleOverrides } = createSettingsActions(deps);
    const res = await updateModuleOverrides({ moduleOverrides: { cms: false } });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(res.data.warnings).toContain('cms_has_published_pages');
    // данные не удаляются — лишь upsert оверрайда.
    expect(deps.upsertSetting).toHaveBeenCalledWith('module_overrides', { cms: false }, 'u-1');
    // before/after зафиксированы аудитом.
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.modules.update');
    expect(auditArg).toHaveProperty('after');
  });

  it('переключает payments (true/false) — модуль присутствует в input-схеме', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateModuleOverrides } = createSettingsActions(deps);

    const resOn = await updateModuleOverrides({ moduleOverrides: { payments: true } });
    expect(resOn.ok).toBe(true);
    if (!resOn.ok) throw new Error('ожидался успех (payments: true)');
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'module_overrides',
      { payments: true },
      'u-1',
    );

    const resOff = await updateModuleOverrides({ moduleOverrides: { payments: false } });
    expect(resOff.ok).toBe(true);
    if (!resOff.ok) throw new Error('ожидался успех (payments: false)');
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'module_overrides',
      { payments: false },
      'u-1',
    );
  });

  it('принимает оверрайды для ВСЕХ модулей из ALL_MODULES', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateModuleOverrides } = createSettingsActions(deps);

    // Полный объект: каждый модуль платформы переключается через action.
    const moduleOverrides = Object.fromEntries(
      ALL_MODULES.map((m) => [m, true]),
    ) as Record<(typeof ALL_MODULES)[number], boolean>;

    const res = await updateModuleOverrides({ moduleOverrides });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех (все модули)');
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'module_overrides',
      moduleOverrides,
      'u-1',
    );
  });

  it('input-схема module_overrides синхронна с ALL_MODULES (нет рассинхрона)', () => {
    // Каждый модуль из ALL_MODULES обязан проходить строгую input-схему.
    for (const m of ALL_MODULES) {
      const parsed = ModuleOverridesInputSchema.safeParse({
        moduleOverrides: { [m]: true },
      });
      expect(parsed.success, `модуль «${m}» должен приниматься input-схемой`).toBe(true);
    }
    // Полный объект всех модулей одновременно тоже валиден.
    const all = Object.fromEntries(ALL_MODULES.map((m) => [m, false]));
    expect(ModuleOverridesInputSchema.safeParse({ moduleOverrides: all }).success).toBe(true);
    // А неизвестный/core-ключ по-прежнему отвергается (.strict()).
    expect(
      ModuleOverridesInputSchema.safeParse({ moduleOverrides: { settings: false } }).success,
    ).toBe(false);
  });

  it('self-lock guard: «Настройки» в навигации при любом module_overrides', () => {
    const user = makeUser([
      'settings.manage',
      'catalog.read',
      'orders.read',
      'cms.read',
      'cdek.manage',
    ]);
    // Всё выключено через env → «Настройки» (core, без module) обязан остаться.
    // env='' → getEnabledModules даёт все модули; для self-lock берём ПУСТОЙ набор,
    // чтобы доказать: даже когда ни одного модуля нет, «Настройки» (core) остаётся.
    const nav = buildAdminNav(user, []);
    const settingsItem = nav.find((i) => i.href === '/admin/settings');
    expect(settingsItem).toBeDefined();
    expect(settingsItem?.module).toBeUndefined();
  });

  it('«Настройки» виден только при наличии settings.manage', () => {
    const allModules = getEnabledModules({});
    const withRight = buildAdminNav(makeUser(['settings.manage']), allModules);
    expect(withRight.some((i) => i.href === '/admin/settings')).toBe(true);
    const withoutRight = buildAdminNav(makeUser(['catalog.read']), allModules);
    expect(withoutRight.some((i) => i.href === '/admin/settings')).toBe(false);
  });
});

// =============================================================================
// resetSetting.
// =============================================================================
describe('settings/actions — resetSetting', () => {
  it('удаляет строку ключа (возврат к env) + audit + invalidate', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { resetSetting } = createSettingsActions(deps);
    const res = await resetSetting({ key: 'branding' });
    expect(res.ok).toBe(true);
    expect(deps.deleteSetting).toHaveBeenCalledWith('branding');
    expect(deps.invalidateCache).toHaveBeenCalled();
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.reset');
  });

  it('неизвестный ключ → validation', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { resetSetting } = createSettingsActions(deps);
    const res = await resetSetting({ key: 'not_a_key' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });
});

// =============================================================================
// legalEntitySchema — ИНН 10/12 (повторно, на уровне схемы).
// =============================================================================
describe('settings/schemas — legalEntitySchema ИНН 10/12', () => {
  it('ИНН 10 цифр валиден', () => {
    expect(legalEntitySchema.safeParse({ inn: '7701234567' }).success).toBe(true);
  });
  it('ИНН 12 цифр валиден', () => {
    expect(legalEntitySchema.safeParse({ inn: '770123456789' }).success).toBe(true);
  });
  it('ИНН 11 цифр невалиден', () => {
    expect(legalEntitySchema.safeParse({ inn: '12345678901' }).success).toBe(false);
  });
  it('ИНН с буквами невалиден', () => {
    expect(legalEntitySchema.safeParse({ inn: '77012abc67' }).success).toBe(false);
  });
});
