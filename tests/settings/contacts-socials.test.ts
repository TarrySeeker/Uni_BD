import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  createSettingsActions,
  type SettingsActionDeps,
} from '@/lib/settings/action-factory';

/**
 * Тесты ADR-018 — проброс contacts.socials через updateLegalAndContacts.
 * Схема contacts уже содержит socials; проверяем, что action принимает,
 * валидирует (url/type), сохраняет и чистит (.strip) лишние поля socials.
 */

function makeUser(perms: PermissionCode[]): AuthUser {
  return { id: 'u-1', email: 'a@shop.io', isOwner: false, permissions: new Set<PermissionCode>(perms) };
}

function makeActionDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

function makeSettingsDeps(actionDeps: ActionDeps): SettingsActionDeps {
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
      main: { buffer: Buffer.from('webp'), width: 1, height: 1, format: 'webp' },
      thumbnail: { buffer: Buffer.from('webp'), width: 1, height: 1, format: 'webp' },
    })),
    getStorage: vi.fn(),
  };
}

describe('settings/actions — contacts.socials', () => {
  it('сохраняет socials в ключ contacts', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateLegalAndContacts } = createSettingsActions(deps);
    const res = await updateLegalAndContacts({
      contacts: {
        phone: '+7 999 000-00-00',
        socials: [
          { type: 'tg', url: 'https://t.me/shop' },
          { type: 'vk', url: 'https://vk.com/shop' },
        ],
      },
    });
    expect(res.ok).toBe(true);
    const upsert = (deps.upsertSetting as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'contacts',
    );
    expect(upsert).toBeDefined();
    const value = upsert![1] as { socials: { type: string; url: string }[] };
    expect(value.socials).toEqual([
      { type: 'tg', url: 'https://t.me/shop' },
      { type: 'vk', url: 'https://vk.com/shop' },
    ]);
  });

  it('strip: лишние поля внутри socials-элемента отбрасываются', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateLegalAndContacts } = createSettingsActions(deps);
    const res = await updateLegalAndContacts({
      contacts: {
        socials: [{ type: 'ig', url: 'https://instagram.com/shop', bogus: 'x' }],
      },
    });
    expect(res.ok).toBe(true);
    const upsert = (deps.upsertSetting as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'contacts',
    );
    const value = upsert![1] as { socials: Record<string, unknown>[] };
    expect(value.socials[0]).toEqual({ type: 'ig', url: 'https://instagram.com/shop' });
    expect('bogus' in value.socials[0]!).toBe(false);
  });

  it('невалидный url в socials → validation, репозиторий не тронут', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateLegalAndContacts } = createSettingsActions(deps);
    const res = await updateLegalAndContacts({
      contacts: { socials: [{ type: 'tg', url: 'not-a-url' }] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });
});
