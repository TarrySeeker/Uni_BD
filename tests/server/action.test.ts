import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineAction,
  PublicActionError,
  type ActionCtx,
  type ActionDeps,
  type ActionHandlerOutput,
  type RequestMeta,
} from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import type { AuditEntry } from '@/lib/audit/log';

// =============================================================================
// ЮНИТ-тесты паттерна Server Action (docs/04 §4.7). Все зависимости (getCurrentUser
// / writeAudit / revalidate / getRequestMeta) замоканы → тесты НЕ трогают БД и
// Next, проходят ВСЕГДА в окружении без БД.
// =============================================================================

// --- Фикстуры пользователей -------------------------------------------------

function makeUser(
  perms: PermissionCode[],
  opts: { isOwner?: boolean; id?: string; email?: string } = {},
): AuthUser {
  return {
    id: opts.id ?? 'u-1',
    email: opts.email ?? 'user@example.com',
    isOwner: opts.isOwner ?? false,
    permissions: new Set<PermissionCode>(perms),
  };
}

// --- Фабрика замоканных deps ------------------------------------------------

interface MockDeps {
  getCurrentUser: ReturnType<typeof vi.fn<ActionDeps['getCurrentUser']>>;
  writeAudit: ReturnType<typeof vi.fn<ActionDeps['writeAudit']>>;
  revalidate: ReturnType<typeof vi.fn<ActionDeps['revalidate']>>;
  getRequestMeta: ReturnType<typeof vi.fn<ActionDeps['getRequestMeta']>>;
}

function makeDeps(
  user: AuthUser | null,
  meta: RequestMeta = { ip: '203.0.113.7', userAgent: 'vitest-UA' },
): MockDeps {
  return {
    getCurrentUser: vi.fn<ActionDeps['getCurrentUser']>(async () => user),
    writeAudit: vi.fn<ActionDeps['writeAudit']>(async () => {}),
    revalidate: vi.fn<ActionDeps['revalidate']>(async () => {}),
    getRequestMeta: vi.fn<ActionDeps['getRequestMeta']>(async () => meta),
  };
}

// Базовая схема входа для большинства тестов.
const inputSchema = z.object({ name: z.string().min(1) });

describe('defineAction — guard → Zod → БД → invalidate → audit (юнит)', () => {
  it('неавторизован (getCurrentUser → null) → error:"unauthorized", handler не вызван', async () => {
    const handler = vi.fn(async () => ({ result: 'ok' }));
    const deps = makeDeps(null);

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'Алиса' });

    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
    expect(deps.writeAudit).not.toHaveBeenCalled();
    expect(deps.revalidate).not.toHaveBeenCalled();
  });

  it('нет права → error:"forbidden", handler не вызван', async () => {
    const handler = vi.fn(async () => ({ result: 'ok' }));
    // пользователь без требуемого права users.manage
    const deps = makeDeps(makeUser(['users.read']));

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'Боб' });

    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
    expect(deps.writeAudit).not.toHaveBeenCalled();
  });

  it('пользователь вовсе без прав → error:"forbidden" (guard опирается на requirePermission)', async () => {
    const handler = vi.fn(async () => ({ result: 'ok' }));
    const deps = makeDeps(makeUser([]));

    const action = defineAction({
      permission: 'roles.manage',
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'C' });

    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('невалидный вход → error:"validation" с fieldErrors, handler не вызван', async () => {
    const handler = vi.fn(async () => ({ result: 'ok' }));
    const deps = makeDeps(makeUser(['users.manage']));

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler,
      deps,
    });

    // name пустой → нарушает min(1)
    const res = await action({ name: '' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.fieldErrors).toBeDefined();
    expect(res.fieldErrors?.name).toBeDefined();
    expect(res.fieldErrors?.name?.length).toBeGreaterThan(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('успешный путь → ok:true с data; writeAudit вызван с actorUserId/ip; revalidate для путей', async () => {
    const audit: AuditEntry = {
      action: 'user.create',
      entityType: 'user',
      entityId: 'new-1',
      after: { name: 'Ева' },
    };
    const handler = vi.fn(
      async (
        data: { name: string },
        _ctx: ActionCtx,
      ): Promise<ActionHandlerOutput<{ id: string; name: string }>> => ({
        result: { id: 'new-1', name: data.name },
        audit,
        revalidate: ['/admin/users', '/admin'],
      }),
    );
    const user = makeUser(['users.manage'], { id: 'actor-9', email: 'admin@shop.io' });
    const deps = makeDeps(user, { ip: '198.51.100.4', userAgent: 'UA-X' });

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'Ева' });

    expect(res).toEqual({ ok: true, data: { id: 'new-1', name: 'Ева' } });
    expect(handler).toHaveBeenCalledTimes(1);

    // Контекст, переданный в handler: user + ip/ua.
    const ctxArg = handler.mock.calls[0]?.[1];
    expect(ctxArg?.user).toBe(user);
    expect(ctxArg?.ip).toBe('198.51.100.4');
    expect(ctxArg?.userAgent).toBe('UA-X');

    // Аудит вызван с actor/ip/ua из контекста.
    expect(deps.writeAudit).toHaveBeenCalledTimes(1);
    expect(deps.writeAudit).toHaveBeenCalledWith(audit, {
      actorUserId: 'actor-9',
      actorEmail: 'admin@shop.io',
      ip: '198.51.100.4',
      userAgent: 'UA-X',
    });

    // Инвалидация по каждому указанному пути.
    expect(deps.revalidate).toHaveBeenCalledTimes(2);
    expect(deps.revalidate).toHaveBeenNthCalledWith(1, '/admin/users');
    expect(deps.revalidate).toHaveBeenNthCalledWith(2, '/admin');
  });

  it('успех без audit/revalidate → ok:true, writeAudit и revalidate НЕ вызваны', async () => {
    const handler = vi.fn(async () => ({ result: 42 }));
    const deps = makeDeps(makeUser(['users.manage']));

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'X' });

    expect(res).toEqual({ ok: true, data: 42 });
    expect(deps.writeAudit).not.toHaveBeenCalled();
    expect(deps.revalidate).not.toHaveBeenCalled();
  });

  it('исключение в handler → error:"internal"', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => {
      throw new Error('падение БД');
    });
    const deps = makeDeps(makeUser(['users.manage']));

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'Y' });

    expect(res).toEqual({ ok: false, error: 'internal' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('owner проходит guard для любого permission', async () => {
    const handler = vi.fn(async () => ({ result: 'owner-ok' }));
    // owner без явных прав в множестве
    const owner = makeUser([], { isOwner: true, id: 'owner-1' });
    const deps = makeDeps(owner);

    const action = defineAction({
      permission: 'roles.manage',
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'Z' });

    expect(res).toEqual({ ok: true, data: 'owner-ok' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('без opts.permission — достаточно аутентификации (guard пропускает любого пользователя)', async () => {
    const handler = vi.fn(async () => ({ result: 'no-perm-needed' }));
    const deps = makeDeps(makeUser([]));

    const action = defineAction({
      input: inputSchema,
      handler,
      deps,
    });

    const res = await action({ name: 'W' });

    expect(res).toEqual({ ok: true, data: 'no-perm-needed' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// i18n серверной локализации ошибок (волна 6-Б, подход B). translate инъектится
// зависимостью — сообщения об ошибках трактуются как i18n-ключи и переводятся в
// язык оператора ВНУТРИ defineAction; контракт ActionResult не меняется.
// =============================================================================

describe('defineAction — серверная локализация ошибок (translate-dep)', () => {
  it('fieldErrors прогоняются через translate (ключ → перевод оператора)', async () => {
    // Схема с сообщением-КЛЮЧОМ, как будет после миграции схем на ключи.
    const schema = z.object({ name: z.string().min(1, 'errors.validation.required') });
    const translate = vi.fn<NonNullable<ActionDeps['translate']>>(async (key) =>
      key === 'errors.validation.required' ? 'Обязательное поле' : key,
    );
    const deps = { ...makeDeps(makeUser(['users.manage'])), translate };

    const action = defineAction({
      permission: 'users.manage',
      input: schema,
      handler: vi.fn(async () => ({ result: 'ok' })),
      deps,
    });

    const res = await action({ name: '' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.fieldErrors?.name).toEqual(['Обязательное поле']);
    expect(translate).toHaveBeenCalledWith('errors.validation.required');
  });

  it('PublicActionError.message переводится, params прокидываются в translate', async () => {
    const translate = vi.fn<NonNullable<ActionDeps['translate']>>(async (key, params) =>
      key === 'errors.emailTaken'
        ? `Email ${params?.email as string} уже занят`
        : key,
    );
    const deps = { ...makeDeps(makeUser(['users.manage'])), translate };

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler: vi.fn(async () => {
        throw new PublicActionError('errors.emailTaken', { email: 'a@b.io' });
      }),
      deps,
    });

    const res = await action({ name: 'Ok' });

    expect(res).toEqual({
      ok: false,
      error: 'validation',
      message: 'Email a@b.io уже занят',
    });
    expect(translate).toHaveBeenCalledWith('errors.emailTaken', { email: 'a@b.io' });
  });

  it('ФОЛБЭК: не-ключ проходит как есть (translate возвращает вход) — частичная миграция безопасна', async () => {
    // translate имитирует дефолт: неизвестный ключ → вход без изменений.
    const translate = vi.fn<NonNullable<ActionDeps['translate']>>(async (key) => key);
    const deps = { ...makeDeps(makeUser(['users.manage'])), translate };

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler: vi.fn(async () => {
        throw new PublicActionError('Сырое русское сообщение (ещё не ключ)');
      }),
      deps,
    });

    const res = await action({ name: 'Ok' });

    expect(res).toEqual({
      ok: false,
      error: 'validation',
      message: 'Сырое русское сообщение (ещё не ключ)',
    });
  });

  it('дефолтный translate (без инъекции) вне реквест-контекста не бросает и отдаёт сырое сообщение', async () => {
    // deps без translate → используется defaultTranslate (best-effort passthrough).
    const deps = makeDeps(makeUser(['users.manage']));

    const action = defineAction({
      permission: 'users.manage',
      input: inputSchema,
      handler: vi.fn(async () => ({ result: 'ok' })),
      deps,
    });

    const res = await action({ name: '' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    // Zod-сообщение по умолчанию доехало без падения (перевод — no-op вне запроса).
    expect(res.fieldErrors?.name?.length).toBeGreaterThan(0);
  });
});
