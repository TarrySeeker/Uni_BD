import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  createSettingsActions,
  I18nInputSchema,
  type SettingsActionDeps,
} from '@/lib/settings/action-factory';

/**
 * T3 — Server Action «Языки» (ключ настроек i18n).
 *
 * Проверяем тот же контракт, что у прочих настроек (guard settings.manage → Zod →
 * upsert → revalidate → audit → сброс memo-кэша) плюс ЗАЩИТУ ЯЗЫКА ПО УМОЛЧАНИЮ:
 * базовые колонки таблиц = канон дефолтного языка, поэтому смена defaultLocale без
 * миграции данных объявила бы весь существующий контент другим языком. Действие
 * обязано отклонять такую попытку даже при наличии права (форма поле блокирует, но
 * форма — не защита).
 */

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

function makeSettingsDeps(
  actionDeps: ActionDeps,
  overrides: Partial<SettingsActionDeps> = {},
): SettingsActionDeps {
  return {
    actionDeps,
    upsertSetting: vi.fn(async (key: string, value: Record<string, unknown>) => ({
      setting_key: key,
      value,
      updated_at: new Date('2026-07-23T00:00:00Z'),
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

/** Строка настроек i18n «как в БД» (сид миграции 0036). */
function i18nRow(value: { defaultLocale: string; locales: string[] }) {
  return {
    setting_key: 'i18n',
    value,
    updated_at: new Date('2026-07-01T00:00:00Z'),
    updated_by: null,
  };
}

describe('settings/actions — updateI18nSettings: права', () => {
  it('не аутентифицирован → unauthorized, БД не тронута', async () => {
    const deps = makeSettingsDeps(makeActionDeps(null));
    const { updateI18nSettings } = createSettingsActions(deps);
    const res = await updateI18nSettings({ i18n: { defaultLocale: 'ru', locales: ['ru'] } });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('без settings.manage → forbidden', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['catalog.read'])));
    const { updateI18nSettings } = createSettingsActions(deps);
    const res = await updateI18nSettings({ i18n: { defaultLocale: 'ru', locales: ['ru'] } });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });
});

describe('settings/actions — updateI18nSettings: сохранение', () => {
  it('сохраняет набор языков, пишет аудит и сбрасывает кэш', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps, {
      getSetting: vi.fn(async () => i18nRow({ defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] })),
    });
    const { updateI18nSettings } = createSettingsActions(deps);

    const res = await updateI18nSettings({ i18n: { defaultLocale: 'ru', locales: ['ru', 'en'] } });

    expect(res.ok).toBe(true);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'i18n',
      { defaultLocale: 'ru', locales: ['ru', 'en'] },
      'u-1',
    );
    expect(deps.invalidateCache).toHaveBeenCalled();
    expect(actionDeps.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.languages.update',
        entityType: 'shop_settings',
        entityId: 'i18n',
        before: { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] },
        after: { defaultLocale: 'ru', locales: ['ru', 'en'] },
      }),
      expect.anything(),
    );
    // Состав языков влияет и на админку, и на витрину.
    const revalidated = (actionDeps.revalidate as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(revalidated).toContain('/admin/settings');
    expect(revalidated).toContain('/');
  });

  it('невалидный набор (defaultLocale вне списка) → validation, БД не тронута', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'])));
    const { updateI18nSettings } = createSettingsActions(deps);
    const res = await updateI18nSettings({ i18n: { defaultLocale: 'ru', locales: ['en'] } });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe('validation');
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });
});

describe('settings/actions — updateI18nSettings: язык по умолчанию неизменяем', () => {
  it('попытка сменить defaultLocale отклоняется с пояснением', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'], true)), {
      getSetting: vi.fn(async () => i18nRow({ defaultLocale: 'ru', locales: ['ru', 'en'] })),
    });
    const { updateI18nSettings } = createSettingsActions(deps);

    const res = await updateI18nSettings({ i18n: { defaultLocale: 'en', locales: ['en', 'ru'] } });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe('validation');
    expect(res.ok === false && res.message).toMatch(/по умолчанию/i);
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('без строки в БД точкой отсчёта служит дефолт платформы (ru)', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'])), {
      getSetting: vi.fn(async () => null),
    });
    const { updateI18nSettings } = createSettingsActions(deps);

    const bad = await updateI18nSettings({ i18n: { defaultLocale: 'en', locales: ['en'] } });
    expect(bad.ok).toBe(false);
    expect(deps.upsertSetting).not.toHaveBeenCalled();

    const good = await updateI18nSettings({ i18n: { defaultLocale: 'ru', locales: ['ru', 'en'] } });
    expect(good.ok).toBe(true);
  });

  it('выключение языка (не дефолтного) разрешено', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'])), {
      getSetting: vi.fn(async () => i18nRow({ defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] })),
    });
    const { updateI18nSettings } = createSettingsActions(deps);
    const res = await updateI18nSettings({ i18n: { defaultLocale: 'ru', locales: ['ru'] } });
    expect(res.ok).toBe(true);
  });
});

describe('settings/actions — resetSetting принимает ключ i18n', () => {
  it('сброс удаляет строку i18n и аудируется', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { resetSetting } = createSettingsActions(deps);
    const res = await resetSetting({ key: 'i18n' });
    expect(res.ok).toBe(true);
    expect(deps.deleteSetting).toHaveBeenCalledWith('i18n');
    expect(actionDeps.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'settings.reset', entityId: 'i18n' }),
      expect.anything(),
    );
  });
});

describe('settings/actions — I18nInputSchema', () => {
  it('требует блок i18n', () => {
    expect(I18nInputSchema.safeParse({}).success).toBe(false);
    expect(
      I18nInputSchema.safeParse({ i18n: { defaultLocale: 'ru', locales: ['ru'] } }).success,
    ).toBe(true);
  });
});
