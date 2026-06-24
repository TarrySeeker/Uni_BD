import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  createSettingsActions,
  type SettingsActionDeps,
} from '@/lib/settings/action-factory';

/**
 * Тесты ADR-018 — uploadSettingsImageAction (logo|favicon|og).
 *
 * Переиспользует существующий пайплайн validateUpload→generatePreviews→put.
 * Все границы (storage/validate/image) инъецируются через SettingsActionDeps,
 * как репозиторий/кеш — тестируем без БД/Next/S3/sharp (ADR-004). Проверяем:
 *   - guard settings.manage;
 *   - reject по magic-bytes (validateUpload.ok=false → validation);
 *   - нормализация в webp (put вызван с 'image/webp');
 *   - logo/favicon → URL в branding.logoUrl/faviconUrl;
 *   - og → S3-KEY в seo.default_og_image_key (не URL);
 *   - audit + invalidate.
 */

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return { id: 'u-1', email: 'a@shop.io', isOwner, permissions: new Set<PermissionCode>(perms) };
}

function makeActionDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

function makeStorage() {
  const put = vi.fn(async (key: string) => ({ key, url: `https://cdn.test/${key}`, size: 1234 }));
  const del = vi.fn(async () => {});
  return {
    put,
    del,
    storage: {
      mode: 'local' as const,
      put,
      get: vi.fn(),
      delete: del,
      url: (key: string) => `https://cdn.test/${key}`,
    },
  };
}

function makeSettingsDeps(
  actionDeps: ActionDeps,
  overrides: Partial<SettingsActionDeps> = {},
): SettingsActionDeps {
  const s = makeStorage();
  return {
    actionDeps,
    upsertSetting: vi.fn(async (key: string, value: Record<string, unknown>) => ({
      setting_key: key,
      value,
      updated_at: new Date('2026-06-23T00:00:00Z'),
      updated_by: 'u-1',
    })),
    deleteSetting: vi.fn(async () => true),
    getSetting: vi.fn(async () => null),
    invalidateCache: vi.fn(() => {}),
    hasPublishedCmsPages: vi.fn(async () => false),
    validateUpload: vi.fn(async () => ({ ok: true, mime: 'image/webp' as const })),
    generatePreviews: vi.fn(async () => ({
      main: { buffer: Buffer.from('webp'), width: 512, height: 512, format: 'webp' },
      thumbnail: { buffer: Buffer.from('webp'), width: 320, height: 320, format: 'webp' },
    })),
    getStorage: vi.fn(() => s.storage),
    ...overrides,
  };
}

function fd(kind: string, bytes = Buffer.from('img')): FormData {
  const form = new FormData();
  form.set('kind', kind);
  form.set('file', new Blob([bytes]), 'pic.png');
  return form;
}

describe('settings/actions — uploadSettingsImageAction', () => {
  it('без settings.manage → forbidden, хранилище не тронуто', async () => {
    const actionDeps = makeActionDeps(makeUser(['catalog.write']));
    const deps = makeSettingsDeps(actionDeps);
    const { uploadSettingsImageAction } = createSettingsActions(deps);
    const res = await uploadSettingsImageAction(fd('logo'));
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.getStorage).not.toHaveBeenCalled();
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('reject по magic-bytes (validateUpload.ok=false) → validation, put не вызван', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps, {
      validateUpload: vi.fn(async () => ({ ok: false, error: 'bad magic' })),
    });
    const { uploadSettingsImageAction } = createSettingsActions(deps);
    const res = await uploadSettingsImageAction(fd('logo'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('logo: нормализация в webp + URL в branding.logoUrl + audit + invalidate', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { uploadSettingsImageAction } = createSettingsActions(deps);
    const res = await uploadSettingsImageAction(fd('logo'));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');

    const storage = (deps.getStorage as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    const putCall = (storage.put as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(putCall[0]).toMatch(/^settings\/logo\/[0-9a-f-]+\.webp$/);
    expect(putCall[2]).toBe('image/webp');

    const upsert = (deps.upsertSetting as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'branding',
    );
    expect(upsert).toBeDefined();
    expect((upsert![1] as { logoUrl: string }).logoUrl).toMatch(/^https:\/\/cdn\.test\/settings\/logo\//);
    expect(deps.invalidateCache).toHaveBeenCalled();
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.image.upload');
  });

  it('favicon: URL пишется в branding.faviconUrl', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { uploadSettingsImageAction } = createSettingsActions(deps);
    const res = await uploadSettingsImageAction(fd('favicon'));
    expect(res.ok).toBe(true);
    const upsert = (deps.upsertSetting as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'branding',
    );
    expect((upsert![1] as { faviconUrl: string }).faviconUrl).toMatch(/^https:\/\/cdn\.test\//);
  });

  it('og: в seo.default_og_image_key пишется S3-KEY (не URL)', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { uploadSettingsImageAction } = createSettingsActions(deps);
    const res = await uploadSettingsImageAction(fd('og'));
    expect(res.ok).toBe(true);
    const upsert = (deps.upsertSetting as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'seo',
    );
    expect(upsert).toBeDefined();
    const key = (upsert![1] as { default_og_image_key: string }).default_og_image_key;
    expect(key).toMatch(/^settings\/og\/[0-9a-f-]+\.webp$/);
    // именно ключ, не URL.
    expect(key.startsWith('http')).toBe(false);
  });

  it('неизвестный kind → validation', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { uploadSettingsImageAction } = createSettingsActions(deps);
    const res = await uploadSettingsImageAction(fd('banner'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });
});

describe('settings/actions — uploadStoreImageAction (возврат ключа для home.*)', () => {
  it('без settings.manage → forbidden, хранилище не тронуто', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['catalog.write'])));
    const { uploadStoreImageAction } = createSettingsActions(deps);
    const res = await uploadStoreImageAction(fd('x'));
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.getStorage).not.toHaveBeenCalled();
  });

  it('успех: webp в settings/home/<uuid>, ВОЗВРАЩАЕТ {key,url}, НЕ пишет в настройки', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { uploadStoreImageAction } = createSettingsActions(deps);
    const res = await uploadStoreImageAction(fd('x'));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    const data = res.data as { key: string; url: string };
    expect(data.key).toMatch(/^settings\/home\/[0-9a-f-]+\.webp$/);
    expect(data.url).toMatch(/^https:\/\/cdn\.test\/settings\/home\//);
    // возврат ключа — без записи в branding/seo/home
    expect(deps.upsertSetting).not.toHaveBeenCalled();
    const storage = (deps.getStorage as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect((storage.put as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBe('image/webp');
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.image.upload');
  });

  it('reject по magic-bytes → validation, put не вызван', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['settings.manage'])), {
      validateUpload: vi.fn(async () => ({ ok: false, error: 'bad' })),
    });
    const { uploadStoreImageAction } = createSettingsActions(deps);
    const res = await uploadStoreImageAction(fd('x'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });
});
