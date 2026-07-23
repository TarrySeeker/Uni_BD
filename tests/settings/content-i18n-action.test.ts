import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  createSettingsActions,
  ContentI18nInputSchema,
  type SettingsActionDeps,
} from '@/lib/settings/action-factory';

/**
 * Волна 5, п.5 ТЗ — Server Action «Перевод настроек» (ключ content_i18n).
 *
 * Контракт как у прочих настроек (guard settings.manage → Zod → upsert →
 * revalidate → audit → сброс memo-кэша) плюс ГЛАВНЫЙ инвариант: merge ОДНОГО
 * языка/секции не затирает переводы соседних языков и секций.
 */
function makeUser(perms: PermissionCode[]): AuthUser {
  return {
    id: 'u-1',
    email: 'admin@shop.io',
    isOwner: false,
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

function contentRow(value: Record<string, unknown>) {
  return {
    setting_key: 'content_i18n',
    value,
    updated_at: new Date('2026-07-01T00:00:00Z'),
    updated_by: null,
  };
}

describe('settings/actions — updateContentI18n: права', () => {
  it('не аутентифицирован → unauthorized, БД не тронута', async () => {
    const deps = makeSettingsDeps(makeActionDeps(null));
    const { updateContentI18n } = createSettingsActions(deps);
    const res = await updateContentI18n({
      locale: 'en',
      section: 'branding',
      patch: { shopName: 'Silk' },
    });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('без settings.manage → forbidden', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['catalog.read'])));
    const { updateContentI18n } = createSettingsActions(deps);
    const res = await updateContentI18n({
      locale: 'en',
      section: 'branding',
      patch: { shopName: 'Silk' },
    });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });
});

describe('settings/actions — updateContentI18n: сохранение и merge', () => {
  it('пишет перевод в новый оверлей, аудирует и сбрасывает кэш', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps, { getSetting: vi.fn(async () => null) });
    const { updateContentI18n } = createSettingsActions(deps);

    const res = await updateContentI18n({
      locale: 'en',
      section: 'home',
      patch: { hero: { title: 'Silk' } },
    });

    expect(res.ok).toBe(true);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'content_i18n',
      { en: { home: { hero: { title: 'Silk' } } } },
      'u-1',
    );
    expect(deps.invalidateCache).toHaveBeenCalled();
    expect(actionDeps.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.content_i18n.update',
        entityType: 'shop_settings',
        entityId: 'content_i18n',
      }),
      expect.anything(),
    );
    const revalidated = (actionDeps.revalidate as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(revalidated).toContain('/admin/settings');
    expect(revalidated).toContain('/');
  });

  it('🔴 merge НЕ затирает соседний язык и соседнюю секцию', async () => {
    const existing = {
      en: {
        home: { hero: { title: 'old' } },
        seo: { site_name: 'Silk EN' },
      },
      fr: { branding: { shopName: 'Soie' } },
    };
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'])), {
      getSetting: vi.fn(async () => contentRow(existing)),
    });
    const { updateContentI18n } = createSettingsActions(deps);

    await updateContentI18n({
      locale: 'en',
      section: 'home',
      patch: { hero: { title: 'new' } },
    });

    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'content_i18n',
      {
        en: {
          // секция home заменена целиком (как home-настройка)...
          home: { hero: { title: 'new' } },
          // ...соседняя секция seo того же языка сохранена...
          seo: { site_name: 'Silk EN' },
        },
        // ...и соседний язык fr не тронут.
        fr: { branding: { shopName: 'Soie' } },
      },
      'u-1',
    );
  });

  it('locale нормализуется (EN → en) — ключ совпадёт с тем, что ищет DTO', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'])));
    const { updateContentI18n } = createSettingsActions(deps);
    await updateContentI18n({ locale: 'EN', section: 'branding', patch: { shopName: 'X' } });
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'content_i18n',
      { en: { branding: { shopName: 'X' } } },
      'u-1',
    );
  });

  it('битый существующий оверлей (не-объект) не роняет действие → пишется чистый merge', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'])), {
      getSetting: vi.fn(async () => contentRow('битьё' as unknown as Record<string, unknown>)),
    });
    const { updateContentI18n } = createSettingsActions(deps);
    const res = await updateContentI18n({
      locale: 'en',
      section: 'branding',
      patch: { shopName: 'X' },
    });
    expect(res.ok).toBe(true);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'content_i18n',
      { en: { branding: { shopName: 'X' } } },
      'u-1',
    );
  });
});

describe('settings/actions — ContentI18nInputSchema', () => {
  it('требует locale/section/patch; отклоняет неизвестную секцию', () => {
    expect(ContentI18nInputSchema.safeParse({}).success).toBe(false);
    expect(
      ContentI18nInputSchema.safeParse({
        locale: 'en',
        section: 'legal_entity',
        patch: {},
      }).success,
    ).toBe(false);
    expect(
      ContentI18nInputSchema.safeParse({
        locale: 'en',
        section: 'home',
        patch: { hero: { title: 'Silk' } },
      }).success,
    ).toBe(true);
  });
});
