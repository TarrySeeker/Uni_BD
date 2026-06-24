import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  createSettingsActions,
  type SettingsActionDeps,
} from '@/lib/settings/action-factory';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — updateShopSeoSettings.
 *
 * defineAction({permission:'settings.manage'}) UPSERT ключа 'seo':
 *   - forbidden без права;
 *   - title_template без '%s' → validation;
 *   - site_url мусор → validation; пусто → ок;
 *   - успех → upsert + audit settings.seo.update + revalidate
 *     ['/sitemap.xml','/robots.txt','/admin/settings/seo'].
 */

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return { id: 'u-1', email: 'a@b.io', isOwner, permissions: new Set<PermissionCode>(perms) };
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

describe('seo/updateShopSeoSettings — guard', () => {
  it('без settings.manage → forbidden, репозиторий не тронут', async () => {
    const actionDeps = makeActionDeps(makeUser(['catalog.write']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateShopSeoSettings } = createSettingsActions(deps);
    const res = await updateShopSeoSettings({ seo: { title_template: '%s — X' } });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('не аутентифицирован → unauthorized', async () => {
    const actionDeps = makeActionDeps(null);
    const deps = makeSettingsDeps(actionDeps);
    const { updateShopSeoSettings } = createSettingsActions(deps);
    const res = await updateShopSeoSettings({ seo: {} });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });
});

describe('seo/updateShopSeoSettings — validation', () => {
  it("title_template без '%s' → validation", async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateShopSeoSettings } = createSettingsActions(deps);
    const res = await updateShopSeoSettings({ seo: { title_template: 'без плейсхолдера' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('site_url мусор → validation', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateShopSeoSettings } = createSettingsActions(deps);
    const res = await updateShopSeoSettings({ seo: { site_url: 'not-a-url' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });
});

describe('seo/updateShopSeoSettings — успех', () => {
  it('валидный seo → upsert ключа seo + audit + revalidate', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateShopSeoSettings } = createSettingsActions(deps);
    const res = await updateShopSeoSettings({
      seo: { site_url: 'https://shop.example', title_template: '%s — Магазин', noindex_site: false },
    });
    expect(res.ok).toBe(true);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'seo',
      expect.objectContaining({ site_url: 'https://shop.example', title_template: '%s — Магазин' }),
      'u-1',
    );
    expect(deps.invalidateCache).toHaveBeenCalled();
    // revalidate путей sitemap/robots/seo-settings.
    const revalidated = (actionDeps.revalidate as any).mock.calls.map((c: any[]) => c[0]);
    expect(revalidated).toEqual(
      expect.arrayContaining(['/sitemap.xml', '/robots.txt', '/admin/settings/seo']),
    );
    // audit settings.seo.update.
    const auditCall = (actionDeps.writeAudit as any).mock.calls[0]?.[0];
    expect(auditCall?.action).toBe('settings.seo.update');
  });

  it('пустой site_url допустим (поле необязательно)', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateShopSeoSettings } = createSettingsActions(deps);
    const res = await updateShopSeoSettings({ seo: { site_name: 'Shop' } });
    expect(res.ok).toBe(true);
  });
});
