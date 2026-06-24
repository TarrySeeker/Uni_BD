/**
 * Слой чтения для управления пользователями и ролями (docs/04 §6.1).
 *
 * Только SELECT через `sql` (tagged templates → параметризация, анти-SQLi) и
 * хелперы перезаписи M2M-привязок (user_roles / role_permissions) внутри
 * транзакции. Мутации сущностей — в admin-actions.ts через defineAction.
 */

import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db/client';

// -----------------------------------------------------------------------------
// Доменные типы чтения (camelCase для UI).
// -----------------------------------------------------------------------------

/** Краткая ссылка на роль (для отображения у пользователя). */
export interface RoleRef {
  id: string;
  code: string;
  title: string;
}

/** Пользователь со списком его ролей (для списка и карточки). */
export interface UserWithRoles {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled' | 'invited';
  isOwner: boolean;
  lastLoginAt: Date | null;
  roles: RoleRef[];
}

/** Роль с числом прав и самими кодами прав (для списка и карточки). */
export interface RoleWithPermissions {
  id: string;
  code: string;
  title: string;
  isSystem: boolean;
  permissionCount: number;
  permissionCodes: string[];
}

// -----------------------------------------------------------------------------
// Пользователи.
// -----------------------------------------------------------------------------

/** Строка соединения users × user_roles × roles (одна на каждую роль). */
interface UserRoleJoinRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'disabled' | 'invited';
  is_owner: boolean;
  last_login_at: Date | string | null;
  created_at: Date | string;
  role_id: string | null;
  role_code: string | null;
  role_title: string | null;
}

function asDateOrNull(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

/**
 * Все пользователи с их ролями (для списка/карточки). Один JOIN-запрос,
 * группировка ролей в JS (упорядочено по дате создания пользователя).
 */
export async function listUsersWithRoles(): Promise<UserWithRoles[]> {
  const rows = await sql<UserRoleJoinRow[]>`
    SELECT
      u.id, u.email, u.display_name, u.status, u.is_owner,
      u.last_login_at, u.created_at,
      r.id    AS role_id,
      r.code  AS role_code,
      r.title AS role_title
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r       ON r.id = ur.role_id
    ORDER BY u.created_at ASC, r.title ASC
    LIMIT 1000
  `;
  return groupUsers(rows);
}

/** Один пользователь со своими ролями (или null). */
export async function getUserById(id: string): Promise<UserWithRoles | null> {
  const rows = await sql<UserRoleJoinRow[]>`
    SELECT
      u.id, u.email, u.display_name, u.status, u.is_owner,
      u.last_login_at, u.created_at,
      r.id    AS role_id,
      r.code  AS role_code,
      r.title AS role_title
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r       ON r.id = ur.role_id
    WHERE u.id = ${id}
    ORDER BY r.title ASC
  `;
  const list = groupUsers(rows);
  return list[0] ?? null;
}

/** Группирует плоские JOIN-строки в пользователей с массивом ролей. */
function groupUsers(rows: UserRoleJoinRow[]): UserWithRoles[] {
  const byId = new Map<string, UserWithRoles>();
  const order: string[] = [];
  for (const row of rows) {
    let user = byId.get(row.id);
    if (!user) {
      user = {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        status: row.status,
        isOwner: row.is_owner,
        lastLoginAt: asDateOrNull(row.last_login_at),
        roles: [],
      };
      byId.set(row.id, user);
      order.push(row.id);
    }
    if (row.role_id && row.role_code && row.role_title) {
      user.roles.push({ id: row.role_id, code: row.role_code, title: row.role_title });
    }
  }
  return order.map((id) => byId.get(id)!);
}

// -----------------------------------------------------------------------------
// Роли.
// -----------------------------------------------------------------------------

interface RolePermJoinRow {
  id: string;
  code: string;
  title: string;
  is_system: boolean;
  permission_code: string | null;
}

/**
 * Все роли с количеством прав и самими кодами прав. Один JOIN-запрос,
 * группировка прав в JS (системные роли — первыми, далее по названию).
 */
export async function listRolesWithPermissionCounts(): Promise<RoleWithPermissions[]> {
  const rows = await sql<RolePermJoinRow[]>`
    SELECT
      r.id, r.code, r.title, r.is_system,
      rp.permission_code
    FROM roles r
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    ORDER BY r.is_system DESC, r.title ASC
    LIMIT 1000
  `;
  return groupRoles(rows);
}

/** Одна роль с её правами (или null). */
export async function getRoleById(id: string): Promise<RoleWithPermissions | null> {
  const rows = await sql<RolePermJoinRow[]>`
    SELECT
      r.id, r.code, r.title, r.is_system,
      rp.permission_code
    FROM roles r
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    WHERE r.id = ${id}
  `;
  const list = groupRoles(rows);
  return list[0] ?? null;
}

/** Группирует плоские JOIN-строки в роли с массивом кодов прав. */
function groupRoles(rows: RolePermJoinRow[]): RoleWithPermissions[] {
  const byId = new Map<string, RoleWithPermissions>();
  const order: string[] = [];
  for (const row of rows) {
    let role = byId.get(row.id);
    if (!role) {
      role = {
        id: row.id,
        code: row.code,
        title: row.title,
        isSystem: row.is_system,
        permissionCount: 0,
        permissionCodes: [],
      };
      byId.set(row.id, role);
      order.push(row.id);
    }
    if (row.permission_code) {
      role.permissionCodes.push(row.permission_code);
      role.permissionCount += 1;
    }
  }
  return order.map((id) => byId.get(id)!);
}

// -----------------------------------------------------------------------------
// Хелперы перезаписи M2M-привязок (DELETE+INSERT в транзакции).
// -----------------------------------------------------------------------------

/**
 * Полностью перезаписывает роли пользователя: снимает старые привязки и ставит
 * заданные. Дубли в `roleIds` гасятся ON CONFLICT (PK user_id+role_id).
 */
export async function assignUserRoles(
  tx: TransactionSql,
  userId: string,
  roleIds: string[],
): Promise<void> {
  await tx`DELETE FROM user_roles WHERE user_id = ${userId}`;
  for (const roleId of roleIds) {
    await tx`
      INSERT INTO user_roles (user_id, role_id)
      VALUES (${userId}, ${roleId})
      ON CONFLICT (user_id, role_id) DO NOTHING
    `;
  }
}

/**
 * Полностью перезаписывает права роли: снимает старые привязки и ставит
 * заданные. Дубли в `codes` гасятся ON CONFLICT (PK role_id+permission_code).
 */
export async function setRolePermissions(
  tx: TransactionSql,
  roleId: string,
  codes: string[],
): Promise<void> {
  await tx`DELETE FROM role_permissions WHERE role_id = ${roleId}`;
  for (const code of codes) {
    await tx`
      INSERT INTO role_permissions (role_id, permission_code)
      VALUES (${roleId}, ${code})
      ON CONFLICT (role_id, permission_code) DO NOTHING
    `;
  }
}
