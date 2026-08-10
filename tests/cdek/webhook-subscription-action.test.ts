import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Тесты Server Action «Проверить подписку на вебхуки» (раздел /admin/cdek).
 *
 * Пайплайн defineAction (docs/04 §4.7): guard (cdek.manage) → Zod → handler
 * (ensureWebhookSubscription) → audit `cdek.webhook.subscription.ensure`.
 * Сервис замокан — проверяем оркестрацию, а не сетевую логику (она в
 * tests/cdek/services/webhook.test.ts).
 */

const ensureMock = vi.fn(async () => ({
  mock: false,
  targetUrl: 'https://shop.example.com/api/cdek/webhook?key=***',
  created: [{ type: 'ORDER_STATUS', uuid: 'sub-1', url: 'https://shop.example.com/api/cdek/webhook?key=***' }],
  kept: [],
  deleted: [],
  errors: [],
}));
vi.mock('@/lib/cdek/services/webhook', () => ({
  ensureWebhookSubscription: (...a: unknown[]) => ensureMock(...(a as [])),
}));

const isModuleEnabledMock = vi.fn(async () => true);
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: (...a: unknown[]) => isModuleEnabledMock(...(a as [])),
}));

let currentUser: AuthUser | null = null;
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => currentUser,
}));

const writeAuditMock = vi.fn(
  async (_entry: Record<string, unknown>, _ctx: unknown) => undefined,
);
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (entry: Record<string, unknown>, ctx: unknown) => writeAuditMock(entry, ctx),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
}));

import { ensureCdekWebhookSubscription } from '@/app/admin/(panel)/cdek/_components/webhook-actions';

function makeUser(perms: PermissionCode[]): AuthUser {
  return {
    id: 'user-1',
    email: 'admin@admik.test',
    roles: [],
    permissions: new Set<PermissionCode>(perms),
  } as unknown as AuthUser;
}

beforeEach(() => {
  vi.clearAllMocks();
  isModuleEnabledMock.mockResolvedValue(true);
  currentUser = makeUser(['cdek.manage']);
});

describe('ensureCdekWebhookSubscription — guard', () => {
  it('аноним → unauthorized, сервис не вызван', async () => {
    currentUser = null;
    const res = await ensureCdekWebhookSubscription({});
    expect(res).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('без права cdek.manage → forbidden', async () => {
    currentUser = makeUser([]);
    const res = await ensureCdekWebhookSubscription({});
    expect(res).toMatchObject({ ok: false, error: 'forbidden' });
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('модуль cdek выключен → validation с публичным сообщением', async () => {
    isModuleEnabledMock.mockResolvedValue(false);
    const res = await ensureCdekWebhookSubscription({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('validation');
      expect(res.message).toContain('выключен');
    }
    expect(ensureMock).not.toHaveBeenCalled();
  });
});

describe('ensureCdekWebhookSubscription — успех', () => {
  it('возвращает отчёт сервиса и пишет audit cdek.webhook.subscription.ensure', async () => {
    const res = await ensureCdekWebhookSubscription({});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.created).toHaveLength(1);
      expect(res.data.targetUrl).toContain('key=***');
    }
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(writeAuditMock).toHaveBeenCalledOnce();
    const [entry] = writeAuditMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(entry.action).toBe('cdek.webhook.subscription.ensure');
    // Аудит не должен содержать немаскированный секрет (в отчёте он уже key=***).
    expect(JSON.stringify(entry)).not.toMatch(/key=(?!\*\*\*)[^&"]+/);
  });
});
