import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ЮНИТ-тесты Server Actions управления пользователями (lib/auth/admin-actions).
 *
 * Все серверные зависимости замоканы → тесты НЕ трогают БД/Next/argon2:
 *   - @/lib/db/client      — sql как tagged-template + sql.begin (controlled rows);
 *   - @/lib/auth/password  — hashPassword (без тяжёлой крипты);
 *   - @/lib/auth/session   — getCurrentUser (guard в defineAction) +
 *                            invalidateUserSessions (ротация сессий цели);
 *   - @/lib/audit/log      — writeAudit (no-op);
 *   - next/cache, next/headers — revalidatePath / headers (серверные API).
 *
 * Фокус находок безопасности:
 *   1) resetUserPassword НЕ должен трогать учётку владельца (privilege escalation);
 *   2) resetUserPassword обязан ротировать сессии цели (invalidateUserSessions);
 *   3) updateUser при отключении (status != active) ротирует сессии цели.
 */

// Управляемое состояние моков. vi.hoisted поднимает фабрику вместе с vi.mock,
// поэтому ссылки внутри vi.mock-фабрик валидны (нельзя ссылаться на обычные
// module-level переменные — они ещё не инициализированы на момент хойстинга).
const h = vi.hoisted(() => {
  /** Очередь ответов sql() (FIFO): каждый tagged-template берёт следующий набор строк. */
  const state: { sqlResults: unknown[][]; sqlCalls: Array<{ text: string }> } = {
    sqlResults: [],
    sqlCalls: [],
  };

  function nextRows(): unknown[] {
    return state.sqlResults.length > 0 ? (state.sqlResults.shift() as unknown[]) : [];
  }

  function sqlImpl(strings?: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    if (Array.isArray(strings)) {
      state.sqlCalls.push({ text: strings.join('?') });
    }
    return Promise.resolve(nextRows());
  }

  const sqlMock = Object.assign(sqlImpl, {
    begin: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(sqlMock)),
  });

  return {
    state,
    sqlMock,
    hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
    invalidateUserSessions: vi.fn(async (_userId: string) => {}),
    writeAudit: vi.fn(async () => {}),
    assignUserRoles: vi.fn(async () => {}),
    setRolePermissions: vi.fn(async () => {}),
    currentUser: { value: null as unknown },
    // Управляемый флаг однопользовательского режима (B9). По умолчанию OFF.
    singleUserMode: { value: false },
  };
});

vi.mock('@/lib/db/client', () => ({ sql: h.sqlMock }));
vi.mock('@/lib/auth/password', () => ({ hashPassword: h.hashPassword }));
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: vi.fn(async () => h.currentUser.value),
  invalidateUserSessions: h.invalidateUserSessions,
}));
vi.mock('@/lib/audit/log', () => ({ writeAudit: h.writeAudit }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({ get: (_k: string) => undefined })),
}));
vi.mock('@/lib/auth/admin-repository', () => ({
  assignUserRoles: h.assignUserRoles,
  setRolePermissions: h.setRolePermissions,
}));
// Однопользовательский режим (B9): admin-actions спрашивает флаг у слоя настроек.
vi.mock('@/lib/config/settings', () => ({
  isSingleUserModeEnabled: vi.fn(async () => h.singleUserMode.value),
}));

// Импорт ПОСЛЕ объявления моков.
import {
  createUser,
  resetUserPassword,
  updateUser,
  createRole,
  updateRole,
  deleteRole,
} from '@/lib/auth/admin-actions';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

const TARGET = '11111111-1111-4111-8111-111111111111';
const ACTOR = '99999999-9999-4999-8999-999999999999';
const ROLE_ADMIN = '22222222-2222-4222-8222-222222222222';

/** Носитель ТОЛЬКО users.manage (без roles.manage). */
function adminUser(): AuthUser {
  return {
    id: ACTOR,
    email: 'admin@shop.io',
    isOwner: false,
    permissions: new Set<PermissionCode>(['users.manage']),
  };
}

/** Носитель и users.manage, и roles.manage — вправе назначать роли. */
function userAndRoleManager(): AuthUser {
  return {
    id: ACTOR,
    email: 'admin@shop.io',
    isOwner: false,
    permissions: new Set<PermissionCode>(['users.manage', 'roles.manage']),
  };
}

beforeEach(() => {
  h.state.sqlResults = [];
  h.state.sqlCalls.length = 0;
  h.hashPassword.mockClear();
  h.invalidateUserSessions.mockClear();
  h.writeAudit.mockClear();
  h.assignUserRoles.mockClear();
  h.setRolePermissions.mockClear();
  h.sqlMock.begin.mockClear();
  h.currentUser.value = adminUser();
  h.singleUserMode.value = false;
});

// =============================================================================
// resetUserPassword — защита владельца + ротация сессий.
// =============================================================================

describe('resetUserPassword — защита владельца (privilege escalation)', () => {
  it('целевой пользователь — владелец → отказ PublicActionError, пароль НЕ меняется', async () => {
    // SELECT is_owner → владелец.
    h.state.sqlResults = [[{ id: TARGET, is_owner: true }]];

    const res = await resetUserPassword({ id: TARGET, password: 'newsecret1' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Владельца магазина нельзя изменять или отключать.');

    // UPDATE password_hash НЕ должен был выполниться.
    const ranUpdate = h.state.sqlCalls.some((c) =>
      /UPDATE\s+users\s+SET\s+password_hash/i.test(c.text),
    );
    expect(ranUpdate).toBe(false);
    // Сессии владельца не трогаем.
    expect(h.invalidateUserSessions).not.toHaveBeenCalled();
  });
});

describe('resetUserPassword — ротация сессий цели', () => {
  it('обычный пользователь → пароль обновлён + invalidateUserSessions(targetId)', async () => {
    // (1) SELECT is_owner → не владелец; (2) UPDATE ... RETURNING id → строка.
    h.state.sqlResults = [[{ id: TARGET, is_owner: false }], [{ id: TARGET }]];

    const res = await resetUserPassword({ id: TARGET, password: 'newsecret1' });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(res.data).toEqual({ id: TARGET });

    expect(h.hashPassword).toHaveBeenCalledWith('newsecret1');
    // Ротация сессий ИМЕННО целевого пользователя.
    expect(h.invalidateUserSessions).toHaveBeenCalledTimes(1);
    expect(h.invalidateUserSessions).toHaveBeenCalledWith(TARGET);
  });

  it('пользователь не найден → "Пользователь не найден.", сессии не трогаем', async () => {
    // (1) SELECT is_owner → не владелец; (2) UPDATE RETURNING → пусто.
    h.state.sqlResults = [[{ id: TARGET, is_owner: false }], []];

    const res = await resetUserPassword({ id: TARGET, password: 'newsecret1' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.message).toBe('Пользователь не найден.');
    expect(h.invalidateUserSessions).not.toHaveBeenCalled();
  });
});

// =============================================================================
// updateUser — защита владельца + ротация при отключении.
// =============================================================================

describe('updateUser — защита владельца и ротация при отключении', () => {
  it('целевой пользователь — владелец → отказ PublicActionError', async () => {
    // assertNotOwner делает первый SELECT и сразу бросает на is_owner=true.
    h.state.sqlResults = [[{ id: TARGET, is_owner: true }]];

    const res = await updateUser({ id: TARGET, displayName: 'Hacked' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.message).toBe('Владельца магазина нельзя изменять или отключать.');
    expect(h.invalidateUserSessions).not.toHaveBeenCalled();
  });

  it('отключение пользователя (status=disabled) → invalidateUserSessions(targetId)', async () => {
    // updateUser делает 2 SELECT: assertNotOwner(id), затем before-снимок.
    h.state.sqlResults = [
      [{ id: TARGET, is_owner: false }],
      [{ id: TARGET, email: 'u@shop.io', display_name: 'U', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: TARGET, status: 'disabled' });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(h.invalidateUserSessions).toHaveBeenCalledTimes(1);
    expect(h.invalidateUserSessions).toHaveBeenCalledWith(TARGET);
  });

  it('обновление без отключения (только displayName) → сессии НЕ ротируем', async () => {
    h.state.sqlResults = [
      [{ id: TARGET, is_owner: false }],
      [{ id: TARGET, email: 'u@shop.io', display_name: 'U', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: TARGET, displayName: 'Новое имя' });

    expect(res.ok).toBe(true);
    expect(h.invalidateUserSessions).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Назначение ролей требует roles.manage (privilege escalation).
//
// БАГ: createUser/updateUser гейтятся ТОЛЬКО на users.manage, но позволяют
// привязывать роли (assignUserRoles) — включая роль с админ-правами. Носитель
// одного users.manage мог бы выдать себе/другому роль с roles.manage/полным
// доступом → эскалация привилегий. Назначение ролей — операция над ролями,
// поэтому требует дополнительно roles.manage.
// =============================================================================

describe('createUser — назначение ролей требует roles.manage', () => {
  it('users.manage без roles.manage + непустые roleIds → отказ, роли НЕ назначаются', async () => {
    // Актор имеет только users.manage.
    h.currentUser.value = adminUser();

    const res = await createUser({
      email: 'new@shop.io',
      password: 'secret123',
      roleIds: [ROLE_ADMIN],
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Недостаточно прав для назначения ролей.');

    // Привязка ролей НЕ должна была произойти.
    expect(h.assignUserRoles).not.toHaveBeenCalled();
    // INSERT пользователя также не выполняется (проверка до записи).
    const ranInsert = h.state.sqlCalls.some((c) => /INSERT\s+INTO\s+users/i.test(c.text));
    expect(ranInsert).toBe(false);
  });

  it('users.manage без roles.manage + пустые roleIds → успех (создание без ролей)', async () => {
    h.currentUser.value = adminUser();
    // INSERT ... RETURNING id.
    h.state.sqlResults = [[{ id: TARGET }]];

    const res = await createUser({
      email: 'new@shop.io',
      password: 'secret123',
      roleIds: [],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(res.data).toEqual({ id: TARGET });
    // assignUserRoles вызывается с пустым набором — снятие/отсутствие ролей.
    expect(h.assignUserRoles).toHaveBeenCalledWith(expect.anything(), TARGET, []);
  });

  it('users.manage + roles.manage + непустые roleIds → успех, роли назначаются', async () => {
    h.currentUser.value = userAndRoleManager();
    h.state.sqlResults = [[{ id: TARGET }]];

    const res = await createUser({
      email: 'new@shop.io',
      password: 'secret123',
      roleIds: [ROLE_ADMIN],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(h.assignUserRoles).toHaveBeenCalledWith(expect.anything(), TARGET, [ROLE_ADMIN]);
  });

  it('владелец (isOwner) + непустые roleIds → успех (короткое замыкание can)', async () => {
    h.currentUser.value = {
      id: ACTOR,
      email: 'owner@shop.io',
      isOwner: true,
      permissions: new Set<PermissionCode>(),
    } satisfies AuthUser;
    h.state.sqlResults = [[{ id: TARGET }]];

    const res = await createUser({
      email: 'new@shop.io',
      password: 'secret123',
      roleIds: [ROLE_ADMIN],
    });

    expect(res.ok).toBe(true);
    expect(h.assignUserRoles).toHaveBeenCalledWith(expect.anything(), TARGET, [ROLE_ADMIN]);
  });
});

describe('updateUser — изменение ролей требует roles.manage', () => {
  it('users.manage без roles.manage + roleIds задан → отказ, роли НЕ меняются', async () => {
    h.currentUser.value = adminUser();
    // assertNotOwner(id) → не владелец; before-снимок.
    h.state.sqlResults = [
      [{ id: TARGET, is_owner: false }],
      [{ id: TARGET, email: 'u@shop.io', display_name: 'U', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: TARGET, roleIds: [ROLE_ADMIN] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Недостаточно прав для назначения ролей.');

    expect(h.assignUserRoles).not.toHaveBeenCalled();
    // UPDATE users SET ... также не должен выполниться.
    const ranUpdate = h.state.sqlCalls.some((c) => /UPDATE\s+users\s+SET/i.test(c.text));
    expect(ranUpdate).toBe(false);
  });

  it('users.manage без roles.manage + roleIds НЕ задан → успех (профиль без ролей)', async () => {
    h.currentUser.value = adminUser();
    h.state.sqlResults = [
      [{ id: TARGET, is_owner: false }],
      [{ id: TARGET, email: 'u@shop.io', display_name: 'U', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: TARGET, displayName: 'Новое имя' });

    expect(res.ok).toBe(true);
    expect(h.assignUserRoles).not.toHaveBeenCalled();
  });

  it('users.manage + roles.manage + roleIds задан → успех, роли меняются', async () => {
    h.currentUser.value = userAndRoleManager();
    h.state.sqlResults = [
      [{ id: TARGET, is_owner: false }],
      [{ id: TARGET, email: 'u@shop.io', display_name: 'U', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: TARGET, roleIds: [ROLE_ADMIN] });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(h.assignUserRoles).toHaveBeenCalledWith(expect.anything(), TARGET, [ROLE_ADMIN]);
  });
});

// =============================================================================
// updateUser — запрет самоснятия СВОИХ ролей (self-lockout).
//
// БАГ (reliability): updateUser блокирует самоотключение (disablingSelf), но НЕ
// блокирует самоснятие собственных ролей. Носитель roles.manage мог бы вызвать
// updateUser({ id: self, roleIds: [...] }) и убрать у себя роли, дающие доступ к
// админке/users.manage → потеря доступа (self-lockout). Зеркалим guard
// disablingSelf для ролей: менять СВОИ роли через этот action нельзя — это должен
// сделать другой администратор.
// =============================================================================

describe('updateUser — запрет смены собственных ролей (self-lockout)', () => {
  it('актор меняет roleIds САМ СЕБЕ → отказ, роли НЕ меняются', async () => {
    // Актор обладает roles.manage (иначе отвалилось бы раньше на assertCanAssignRoles),
    // но даже так не вправе трогать СВОИ роли через этот action. id === self (ACTOR).
    h.currentUser.value = userAndRoleManager();
    // assertNotOwner(self) → не владелец; before-снимок (на случай, если до него дойдёт).
    h.state.sqlResults = [
      [{ id: ACTOR, is_owner: false }],
      [{ id: ACTOR, email: 'admin@shop.io', display_name: 'A', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: ACTOR, roleIds: [] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Нельзя менять собственные роли — попросите другого администратора.');

    // Привязка ролей НЕ должна была произойти.
    expect(h.assignUserRoles).not.toHaveBeenCalled();
    // UPDATE users SET ... также не должен выполниться.
    const ranUpdate = h.state.sqlCalls.some((c) => /UPDATE\s+users\s+SET/i.test(c.text));
    expect(ranUpdate).toBe(false);
  });

  it('актор меняет roleIds ДРУГОМУ (с roles.manage) → успех, роли меняются', async () => {
    // Контроль: запрет касается ТОЛЬКО собственных ролей, чужие — можно (TARGET != ACTOR).
    h.currentUser.value = userAndRoleManager();
    h.state.sqlResults = [
      [{ id: TARGET, is_owner: false }],
      [{ id: TARGET, email: 'u@shop.io', display_name: 'U', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: TARGET, roleIds: [ROLE_ADMIN] });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(h.assignUserRoles).toHaveBeenCalledWith(expect.anything(), TARGET, [ROLE_ADMIN]);
  });

  it('актор меняет СВОЙ профиль (displayName) без roleIds → успех (профиль свой менять можно)', async () => {
    // Контроль: запрет касается ТОЛЬКО ролей; свой профиль (без roleIds) править можно.
    h.currentUser.value = userAndRoleManager();
    h.state.sqlResults = [
      [{ id: ACTOR, is_owner: false }],
      [{ id: ACTOR, email: 'admin@shop.io', display_name: 'A', status: 'active', is_owner: false }],
    ];

    const res = await updateUser({ id: ACTOR, displayName: 'Новое имя' });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(h.assignUserRoles).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Однопользовательский режим (B9): серверная блокировка управления
// пользователями и ролями ДО любых записей в БД. Флаг — per-shop настройка
// (access.singleUserMode), дефолт OFF. Блок применяется ко ВСЕМ, включая
// владельца (isOwner) — это режим магазина, а не право.
// =============================================================================

/** Владелец — проходит любые RBAC-проверки, но НЕ обходит режим магазина. */
function ownerUser(): AuthUser {
  return {
    id: ACTOR,
    email: 'owner@shop.io',
    isOwner: true,
    permissions: new Set<PermissionCode>(),
  };
}

describe('createUser — однопользовательский режим', () => {
  it('режим включён → отказ, INSERT пользователя НЕ выполняется (даже у владельца)', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = true;

    const res = await createUser({ email: 'new@shop.io', password: 'secret123', roleIds: [] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Однопользовательский режим: создание пользователей отключено.');

    const ranInsert = h.state.sqlCalls.some((c) => /INSERT\s+INTO\s+users/i.test(c.text));
    expect(ranInsert).toBe(false);
    expect(h.assignUserRoles).not.toHaveBeenCalled();
    // Пароль даже не хешируется (проверка до тяжёлой крипты).
    expect(h.hashPassword).not.toHaveBeenCalled();
  });

  it('режим выключен (дефолт) → создание работает как раньше', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = false;
    h.state.sqlResults = [[{ id: TARGET }]];

    const res = await createUser({ email: 'new@shop.io', password: 'secret123', roleIds: [] });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех');
    expect(res.data).toEqual({ id: TARGET });
  });
});

describe('createRole — однопользовательский режим', () => {
  it('режим включён → отказ, INSERT роли НЕ выполняется', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = true;

    const res = await createRole({ code: 'support', title: 'Поддержка', permissionCodes: [] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.message).toBe('Однопользовательский режим: управление ролями отключено.');
    const ranInsert = h.state.sqlCalls.some((c) => /INSERT\s+INTO\s+roles/i.test(c.text));
    expect(ranInsert).toBe(false);
    expect(h.setRolePermissions).not.toHaveBeenCalled();
  });

  it('режим выключен → создание роли работает', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = false;
    h.state.sqlResults = [[{ id: TARGET }]];

    const res = await createRole({ code: 'support', title: 'Поддержка', permissionCodes: [] });
    expect(res.ok).toBe(true);
  });
});

describe('updateRole / deleteRole — однопользовательский режим', () => {
  it('updateRole при включённом режиме → отказ, UPDATE roles НЕ выполняется', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = true;

    const res = await updateRole({ id: TARGET, title: 'Новое' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.message).toBe('Однопользовательский режим: управление ролями отключено.');
    const ranUpdate = h.state.sqlCalls.some((c) => /UPDATE\s+roles\s+SET/i.test(c.text));
    expect(ranUpdate).toBe(false);
  });

  it('deleteRole при включённом режиме → отказ, DELETE roles НЕ выполняется', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = true;

    const res = await deleteRole({ id: TARGET });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.message).toBe('Однопользовательский режим: управление ролями отключено.');
    const ranDelete = h.state.sqlCalls.some((c) => /DELETE\s+FROM\s+roles/i.test(c.text));
    expect(ranDelete).toBe(false);
  });
});

// F1 security-review: блок применяется ко ВСЕМ 6 user/role-мутациям, не только к
// create*. Тесты ниже инвентаризируют оставшиеся два (updateUser/resetUserPassword),
// чтобы будущая правка не сняла guard незаметно.
describe('updateUser / resetUserPassword — однопользовательский режим', () => {
  it('updateUser при включённом режиме → отказ, UPDATE users НЕ выполняется', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = true;

    const res = await updateUser({ id: TARGET, displayName: 'Hacked' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.message).toBe('Однопользовательский режим: управление пользователями отключено.');
    const ranUpdate = h.state.sqlCalls.some((c) => /UPDATE\s+users\s+SET/i.test(c.text));
    expect(ranUpdate).toBe(false);
  });

  it('resetUserPassword при включённом режиме → отказ, без хеша пароля и UPDATE', async () => {
    h.currentUser.value = ownerUser();
    h.singleUserMode.value = true;

    const res = await resetUserPassword({ id: TARGET, password: 'newsecret1' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.message).toBe('Однопользовательский режим: управление пользователями отключено.');
    expect(h.hashPassword).not.toHaveBeenCalled();
    const ranUpdate = h.state.sqlCalls.some((c) => /UPDATE\s+users\s+SET/i.test(c.text));
    expect(ranUpdate).toBe(false);
  });
});
