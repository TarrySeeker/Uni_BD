import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  LeadStatusInputSchema,
  LeadIdInputSchema,
} from '@/lib/leads/schemas';
import { createLeadActions, type LeadActionDeps } from '@/lib/leads/actions';

/**
 * G-09 (обработка заявок): юнит-тесты Server Actions смены статуса / удаления.
 * Без БД/Next — репозиторий и пайплайн инъецированы (createLeadActions(deps)),
 * по образцу createSettingsActions. Проверяем: guard orders.write, валидацию,
 * вызов whitelist-перехода (canLeadTransition), revalidate и audit.
 */

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return {
    id: 'u-1',
    email: 'owner@shop.io',
    isOwner,
    permissions: new Set<PermissionCode>(perms),
  };
}

function makeActionDeps(user: AuthUser | null): {
  actionDeps: ActionDeps;
  writeAudit: ReturnType<typeof vi.fn>;
  revalidate: ReturnType<typeof vi.fn>;
} {
  const writeAudit = vi.fn(async () => {});
  const revalidate = vi.fn(async () => {});
  return {
    actionDeps: {
      getCurrentUser: vi.fn(async () => user),
      writeAudit,
      revalidate,
      getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
    },
    writeAudit,
    revalidate,
  };
}

function makeRepoDeps() {
  return {
    getLeadStatus: vi.fn(async (_id: string) => 'new' as string | null),
    updateLeadStatus: vi.fn(async () => true),
    deleteLead: vi.fn(async () => true),
  };
}

function build(
  user: AuthUser | null,
  repo: ReturnType<typeof makeRepoDeps> = makeRepoDeps(),
) {
  const a = makeActionDeps(user);
  const deps: LeadActionDeps = { actionDeps: a.actionDeps, ...repo };
  return { actions: createLeadActions(deps), repo, ...a };
}

const VALID_ID = '11111111-1111-4111-8111-111111111111';

describe('LeadStatusInputSchema / LeadIdInputSchema', () => {
  it('валидный статус и uuid проходят', () => {
    expect(
      LeadStatusInputSchema.safeParse({ id: VALID_ID, status: 'in_progress' }).success,
    ).toBe(true);
    expect(LeadIdInputSchema.safeParse({ id: VALID_ID }).success).toBe(true);
  });

  it('неизвестный статус / не-uuid → ошибка', () => {
    expect(LeadStatusInputSchema.safeParse({ id: VALID_ID, status: 'bogus' }).success).toBe(false);
    expect(LeadStatusInputSchema.safeParse({ id: 'not-a-uuid', status: 'done' }).success).toBe(false);
    expect(LeadIdInputSchema.safeParse({ id: 'nope' }).success).toBe(false);
  });
});

describe('setLeadStatus — guard orders.write', () => {
  it('не аутентифицирован → unauthorized, репозиторий не тронут', async () => {
    const { actions, repo } = build(null);
    const res = await actions.setLeadStatus({ id: VALID_ID, status: 'in_progress' });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(repo.updateLeadStatus).not.toHaveBeenCalled();
  });

  it('только orders.read → forbidden', async () => {
    const { actions, repo } = build(makeUser(['orders.read']));
    const res = await actions.setLeadStatus({ id: VALID_ID, status: 'in_progress' });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(repo.updateLeadStatus).not.toHaveBeenCalled();
  });

  it('orders.write → проходит, обновляет статус, пишет audit и revalidate', async () => {
    const { actions, repo, writeAudit, revalidate } = build(makeUser(['orders.write']));
    const res = await actions.setLeadStatus({ id: VALID_ID, status: 'in_progress' });
    expect(res.ok).toBe(true);
    expect(repo.updateLeadStatus).toHaveBeenCalledWith(VALID_ID, 'in_progress');
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith('/admin/leads');
    const auditArg = writeAudit.mock.calls[0]![0] as { action: string; entityType: string };
    expect(auditArg.action).toBe('lead.status.change');
    expect(auditArg.entityType).toBe('lead');
  });

  it('owner проходит без явного права', async () => {
    const { actions } = build(makeUser([], true));
    const res = await actions.setLeadStatus({ id: VALID_ID, status: 'done' });
    expect(res.ok).toBe(true);
  });
});

describe('setLeadStatus — бизнес-правила', () => {
  it('недопустимый переход (new → new) → validation, статус не пишется', async () => {
    const repo = makeRepoDeps();
    repo.getLeadStatus.mockResolvedValue('new');
    const { actions } = build(makeUser(['orders.write']), repo);
    const res = await actions.setLeadStatus({ id: VALID_ID, status: 'new' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBeTruthy();
    expect(repo.updateLeadStatus).not.toHaveBeenCalled();
  });

  it('заявка не найдена → validation (понятное сообщение)', async () => {
    const repo = makeRepoDeps();
    repo.getLeadStatus.mockResolvedValue(null);
    const { actions } = build(makeUser(['orders.write']), repo);
    const res = await actions.setLeadStatus({ id: VALID_ID, status: 'done' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(repo.updateLeadStatus).not.toHaveBeenCalled();
  });

  it('невалидный статус во входе → validation + fieldErrors, репозиторий не тронут', async () => {
    const repo = makeRepoDeps();
    const { actions } = build(makeUser(['orders.write']), repo);
    const res = await actions.setLeadStatus({ id: VALID_ID, status: 'bogus' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.fieldErrors?.status).toBeTruthy();
    expect(repo.getLeadStatus).not.toHaveBeenCalled();
  });
});

describe('deleteLead — guard orders.write', () => {
  it('только orders.read → forbidden', async () => {
    const { actions, repo } = build(makeUser(['orders.read']));
    const res = await actions.deleteLead({ id: VALID_ID });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(repo.deleteLead).not.toHaveBeenCalled();
  });

  it('orders.write → удаляет, пишет audit (lead.delete) и revalidate', async () => {
    const { actions, repo, writeAudit, revalidate } = build(makeUser(['orders.write']));
    const res = await actions.deleteLead({ id: VALID_ID });
    expect(res.ok).toBe(true);
    expect(repo.deleteLead).toHaveBeenCalledWith(VALID_ID);
    expect(revalidate).toHaveBeenCalledWith('/admin/leads');
    const auditArg = writeAudit.mock.calls[0]![0] as { action: string };
    expect(auditArg.action).toBe('lead.delete');
  });

  it('заявка не найдена → validation', async () => {
    const repo = makeRepoDeps();
    repo.deleteLead.mockResolvedValue(false);
    const { actions } = build(makeUser(['orders.write']), repo);
    const res = await actions.deleteLead({ id: VALID_ID });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });
});
