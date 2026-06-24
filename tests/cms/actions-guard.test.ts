import { describe, expect, it, vi } from 'vitest';

import { defineAction, type ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { CmsPageCreateSchema } from '@/lib/cms/schemas';

/**
 * ЮНИТ (без БД/Next): мутации CMS, собранные через defineAction с реальной
 * Zod-схемой CMS, корректно проходят guard (cms.write) и валидацию — handler
 * замокан, deps инъецированы. Подтверждает: схемы CMS совместимы с пайплайном
 * ядра; guard опирается на cms.write; невалидный slug → validation + fieldErrors.
 */

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return {
    id: 'u-1',
    email: 'u@shop.io',
    isOwner,
    permissions: new Set<PermissionCode>(perms),
  };
}

function makeDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

function buildCreatePageAction(
  deps: ActionDeps,
  handler = vi.fn(async () => ({ result: { id: 'new' } })),
) {
  return {
    action: defineAction({
      permission: 'cms.write',
      input: CmsPageCreateSchema,
      handler,
      deps,
    }),
    handler,
  };
}

const validInput = { title: 'О компании', slug: 'about' };

describe('CMS через defineAction — guard cms.write', () => {
  it('не аутентифицирован → unauthorized, handler не вызван', async () => {
    const deps = makeDeps(null);
    const { action, handler } = buildCreatePageAction(deps);
    const res = await action(validInput);
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('есть только cms.read → forbidden', async () => {
    const deps = makeDeps(makeUser(['cms.read']));
    const { action, handler } = buildCreatePageAction(deps);
    const res = await action(validInput);
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('cms.write → проходит guard, handler вызван', async () => {
    const deps = makeDeps(makeUser(['cms.write']));
    const { action, handler } = buildCreatePageAction(deps);
    const res = await action(validInput);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('owner проходит без явного права', async () => {
    const deps = makeDeps(makeUser([], true));
    const { action, handler } = buildCreatePageAction(deps);
    const res = await action(validInput);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('невалидный slug → validation + fieldErrors, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['cms.write']));
    const { action, handler } = buildCreatePageAction(deps);
    const res = await action({ title: 'Заголовок', slug: 'Невалидный SLUG' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.fieldErrors).toBeTruthy();
    expect(res.fieldErrors!.slug).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
  });

  it('slug опционален (title без slug проходит валидацию)', async () => {
    const deps = makeDeps(makeUser(['cms.write']));
    const { action, handler } = buildCreatePageAction(deps);
    const res = await action({ title: 'Только заголовок' });
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
