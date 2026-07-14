import { describe, expect, it, vi } from 'vitest';

import { defineAction, type ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  DesignerCreateSchema,
  DesignerUpdateSchema,
  DesignerIdSchema,
} from '@/lib/designers/schemas';

/**
 * ЮНИТ — админ-CRUD дизайнеров через defineAction с РЕАЛЬНЫМИ Zod-схемами:
 * guard опирается на catalog.write (как бренды — отдельного права НЕ вводим),
 * валидация отклоняет мусор, handler изолирован (замокан, deps инъецированы).
 * Без БД/Next.
 */

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return { id: 'u-1', email: 'u@shop.io', isOwner, permissions: new Set<PermissionCode>(perms) };
}

function makeDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

function buildCreate(deps: ActionDeps, handler = vi.fn(async () => ({ result: { id: 'new' } }))) {
  return {
    action: defineAction({
      permission: 'catalog.write',
      input: DesignerCreateSchema,
      handler,
      deps,
    }),
    handler,
  };
}

const validInput = { name: 'Джейн Доу' };

describe('дизайнеры через defineAction — guard catalog.write', () => {
  it('не аутентифицирован → unauthorized, handler не вызван', async () => {
    const deps = makeDeps(null);
    const { action, handler } = buildCreate(deps);
    const res = await action(validInput);
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('только catalog.read → forbidden', async () => {
    const deps = makeDeps(makeUser(['catalog.read']));
    const { action, handler } = buildCreate(deps);
    const res = await action(validInput);
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('catalog.write → проходит guard, handler вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildCreate(deps);
    const res = await action(validInput);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('owner проходит без явного права', async () => {
    const deps = makeDeps(makeUser([], true));
    const { action, handler } = buildCreate(deps);
    const res = await action(validInput);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('невалидный вход (пустое имя) → validation, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const handler = vi.fn(async () => ({ result: { id: 'x' } }));
    const action = defineAction({
      permission: 'catalog.write',
      input: DesignerCreateSchema,
      handler,
      deps,
    });
    const res = await action({ name: '   ' });
    expect(res.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('update/delete-схемы совместимы с пайплайном (guard catalog.write)', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const upd = defineAction({
      permission: 'catalog.write',
      input: DesignerUpdateSchema,
      handler: vi.fn(async () => ({ result: { id: 'd1' } })),
      deps,
    });
    const del = defineAction({
      permission: 'catalog.write',
      input: DesignerIdSchema,
      handler: vi.fn(async () => ({ result: { id: 'd1' } })),
      deps,
    });
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await upd({ id, name: 'Новое имя' })).ok).toBe(true);
    expect((await del({ id })).ok).toBe(true);
  });
});
