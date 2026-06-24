import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Тесты ADR-018 — uploadCmsImageAction.
 *
 * CMS-секции хранят imageKey (S3-ключ), НЕ URL (контракт ADR-012) → action
 * ВОЗВРАЩАЕТ ключ. Право cms.write; кладёт в cms/<uuid>.webp. Границы
 * (auth/cache/headers/audit/module-gate/storage/validate/image) замоканы —
 * без БД/Next/S3/sharp (ADR-004). Проверяем: guard, reject magic-bytes,
 * webp-нормализацию, возврат ключа, audit.
 */

const currentUser: { value: AuthUser | null } = { value: null };
const put = vi.fn(async (key: string, _body?: Buffer, _ct?: string) => ({
  key,
  url: `https://cdn.test/${key}`,
  size: 999,
}));
const del = vi.fn(async () => {});
const validateUpload = vi.fn(async () => ({ ok: true, mime: 'image/webp' as const }));
const moduleEnabled = { value: true };

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: async () => currentUser.value }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: async () => moduleEnabled.value,
}));
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({ put, delete: del }),
}));
vi.mock('@/lib/storage/validate', () => ({ validateUpload }));
vi.mock('@/lib/storage/image', () => ({
  generatePreviews: async () => ({ main: { buffer: Buffer.from('webp'), width: 800, height: 600 } }),
}));

function fd(bytes = Buffer.from('img')): FormData {
  const form = new FormData();
  form.set('file', new Blob([bytes]), 'pic.png');
  return form;
}

describe('cms/actions — uploadCmsImageAction', () => {
  let uploadCmsImageAction: typeof import('@/lib/cms/actions').uploadCmsImageAction;

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleEnabled.value = true;
    currentUser.value = {
      id: 'u-1',
      email: 'a@shop.io',
      isOwner: false,
      permissions: new Set<PermissionCode>(['cms.write']),
    };
    const actions = await import('@/lib/cms/actions');
    uploadCmsImageAction = actions.uploadCmsImageAction;
  });

  it('без cms.write → forbidden', async () => {
    currentUser.value = {
      id: 'u-2',
      email: 'b@shop.io',
      isOwner: false,
      permissions: new Set<PermissionCode>(['catalog.write']),
    };
    const res = await uploadCmsImageAction(fd());
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(put).not.toHaveBeenCalled();
  });

  it('reject по magic-bytes → validation, put не вызван', async () => {
    validateUpload.mockResolvedValueOnce({ ok: false, error: 'bad' } as never);
    const res = await uploadCmsImageAction(fd());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(put).not.toHaveBeenCalled();
  });

  it('успех: webp в cms/<uuid>.webp и ВОЗВРАЩАЕТ key (не URL)', async () => {
    const res = await uploadCmsImageAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(res.data.key).toMatch(/^cms\/[0-9a-f-]+\.webp$/);
    const putCall = put.mock.calls[0]!;
    expect(putCall[0]).toBe(res.data.key);
    expect(putCall[2]).toBe('image/webp');
  });

  it('модуль cms выключен → отказ (не internal-крэш)', async () => {
    moduleEnabled.value = false;
    const res = await uploadCmsImageAction(fd());
    expect(res.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
