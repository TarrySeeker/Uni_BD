'use server';

import type { TransactionSql } from 'postgres';

import { defineAction, PublicActionError, type ActionCtx } from '@/lib/server/action';
import { sql } from '@/lib/db/client';
import { hashPassword } from '@/lib/auth/password';
import { invalidateUserSessions } from '@/lib/auth/session';
import { ALL_PERMISSIONS } from '@/lib/auth/permissions';
import { can } from '@/lib/auth/rbac';

import {
  UserCreateSchema,
  UserUpdateSchema,
  UserPasswordResetSchema,
  RoleCreateSchema,
  RoleUpdateSchema,
  RoleIdSchema,
} from './admin-schemas';
import { assignUserRoles, setRolePermissions } from './admin-repository';

/**
 * Server Actions управления пользователями и ролями (docs/04 §6.1).
 *
 * Все мутации — через единый пайплайн defineAction (§4.7): guard (users.manage /
 * roles.manage) → Zod → handler (БД через sql, параметризовано) → revalidate →
 * audit. Чувствительные поля (пароль/хеш) НИКОГДА не уходят в аудит — пишем
 * только безопасные снимки; санитайзер аудита дополнительно вырезает секреты.
 *
 * Бизнес-отказы, которые надо показать владельцу понятной фразой (дубликат
 * email, защита владельца), бросаются как PublicActionError — пайплайн отдаёт
 * их текст в форму.
 */

// -----------------------------------------------------------------------------
// Общие хелперы.
// -----------------------------------------------------------------------------

/** Пути инвалидации разделов. */
const USERS_PATH = '/admin/users';
const ROLES_PATH = '/admin/roles';

/** Код нарушения уникальности PostgreSQL. */
const PG_UNIQUE_VIOLATION = '23505';

/** true, если ошибка — нарушение уникального индекса. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

/** Множество известных кодов прав — фильтр против неизвестных (FK на permissions). */
const KNOWN_PERMISSION_CODES = new Set<string>(ALL_PERMISSIONS.map((p) => p.code));

/** Оставляет только существующие коды прав (защита от мусора/FK-нарушения). */
function filterKnownPermissions(codes: string[]): string[] {
  return codes.filter((c) => KNOWN_PERMISSION_CODES.has(c));
}

/**
 * Гард против эскалации привилегий через назначение ролей (RBAC §5.4).
 *
 * createUser/updateUser гейтятся на `users.manage`, но привязка ролей
 * (assignUserRoles) — это операция НАД РОЛЯМИ: выдав пользователю роль с
 * `roles.manage`/полным доступом, носитель одного `users.manage` повысил бы
 * себе/другому права. Поэтому ЛЮБОЕ назначение/изменение ролей пользователя
 * дополнительно требует `roles.manage` — того же права, которым гейтятся
 * create/update/deleteRole. Владелец (`is_owner`) проходит за счёт короткого
 * замыкания в `can()`. Бросает PublicActionError, если права нет.
 */
function assertCanAssignRoles(ctx: ActionCtx): void {
  if (!can(ctx.user, 'roles.manage')) {
    throw new PublicActionError('Недостаточно прав для назначения ролей.');
  }
}

/**
 * Серверный гард защиты владельца магазина (RBAC §5.4): учётку с is_owner нельзя
 * изменять, отключать или сбрасывать ей пароль через UI — иначе любой носитель
 * users.manage мог бы перехватить владельца (privilege escalation).
 *
 * Читает users.is_owner по id и бросает PublicActionError, если это владелец.
 * Возвращает строку пользователя (id/is_owner), чтобы вызывающий мог отличить
 * «не найден» (null) от «найден, не владелец» без повторного SELECT.
 */
async function assertNotOwner(id: string): Promise<{ id: string; is_owner: boolean } | null> {
  const rows = await sql<{ id: string; is_owner: boolean }[]>`
    SELECT id, is_owner FROM users WHERE id = ${id} LIMIT 1
  `;
  const row = rows[0];
  if (row?.is_owner) {
    throw new PublicActionError('Владельца магазина нельзя изменять или отключать.');
  }
  return row ?? null;
}

// =============================================================================
// ПОЛЬЗОВАТЕЛИ.
// =============================================================================

export const createUser = defineAction({
  permission: 'users.manage',
  input: UserCreateSchema,
  handler: async (data, ctx: ActionCtx) => {
    // Anti-escalation: назначение ролей требует roles.manage (до любой записи).
    // Создание без ролей доступно носителю одного users.manage.
    if (data.roleIds.length > 0) {
      assertCanAssignRoles(ctx);
    }

    const passwordHash = await hashPassword(data.password);

    let userId: string;
    try {
      userId = await sql.begin(async (tx: TransactionSql) => {
        const rows = await tx<{ id: string }[]>`
          INSERT INTO users (email, password_hash, display_name, status)
          VALUES (${data.email}, ${passwordHash}, ${data.displayName}, ${data.status})
          RETURNING id
        `;
        const id = rows[0]!.id;
        await assignUserRoles(tx, id, data.roleIds);
        return id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new PublicActionError('Пользователь с таким email уже существует.');
      }
      throw err;
    }

    return {
      result: { id: userId },
      revalidate: [USERS_PATH],
      audit: {
        action: 'user.create',
        entityType: 'user',
        entityId: userId,
        // Пароль/хеш в аудит НЕ пишем — только безопасные поля.
        after: {
          email: data.email,
          displayName: data.displayName,
          status: data.status,
          roleIds: data.roleIds,
        },
      },
    };
  },
});

export const updateUser = defineAction({
  permission: 'users.manage',
  input: UserUpdateSchema,
  handler: async (data, ctx: ActionCtx) => {
    // Защита владельца — единый хелпер (бросает PublicActionError, если is_owner).
    await assertNotOwner(data.id);

    // Anti-escalation: изменение ролей (включая снятие) требует roles.manage —
    // до любой записи. Обновление профиля без ролей доступно носителю users.manage.
    if (data.roleIds !== undefined) {
      assertCanAssignRoles(ctx);
    }

    // Защита от self-lockout: менять СВОИ роли через этот action нельзя. Иначе
    // не-владелец-админ мог бы снять у себя роли, дающие доступ к админке/
    // users.manage, и потерять доступ. Зеркало guard disablingSelf (ниже) для
    // ролей: смену собственных ролей должен делать другой администратор.
    // Владелец сюда не дойдёт — его раньше отсекает assertNotOwner.
    const changingOwnRoles = data.roleIds !== undefined && data.id === ctx.user.id;
    if (changingOwnRoles) {
      throw new PublicActionError(
        'Нельзя менять собственные роли — попросите другого администратора.',
      );
    }

    const before = await sql<
      { id: string; email: string; display_name: string; status: string }[]
    >`
      SELECT id, email, display_name, status
      FROM users WHERE id = ${data.id} LIMIT 1
    `;
    if (!before[0]) {
      throw new PublicActionError('Пользователь не найден.');
    }

    // Нельзя отключить самого себя — иначе можно потерять доступ к админке.
    const disablingSelf =
      data.id === ctx.user.id && data.status !== undefined && data.status !== 'active';
    if (disablingSelf) {
      throw new PublicActionError('Нельзя отключить собственную учётную запись.');
    }

    await sql.begin(async (tx: TransactionSql) => {
      await tx`
        UPDATE users SET
          display_name = COALESCE(${data.displayName ?? null}, display_name),
          status       = COALESCE(${data.status ?? null}, status),
          updated_at   = now()
        WHERE id = ${data.id}
      `;
      if (data.roleIds !== undefined) {
        await assignUserRoles(tx, data.id, data.roleIds);
      }
    });

    // Отключение пользователя (status != active) — ротация сессий: гасим все его
    // сессии, иначе уже выданные cookie остались бы валидными после блокировки.
    const disabling = data.status !== undefined && data.status !== 'active';
    if (disabling) {
      await invalidateUserSessions(data.id);
    }

    return {
      result: { id: data.id },
      revalidate: [USERS_PATH],
      audit: {
        action: 'user.update',
        entityType: 'user',
        entityId: data.id,
        before: {
          displayName: before[0].display_name,
          status: before[0].status,
        },
        after: {
          displayName: data.displayName ?? before[0].display_name,
          status: data.status ?? before[0].status,
          roleIds: data.roleIds,
        },
      },
    };
  },
});

export const resetUserPassword = defineAction({
  permission: 'users.manage',
  input: UserPasswordResetSchema,
  handler: async (data, _ctx: ActionCtx) => {
    // Защита владельца (RBAC §5.4): нельзя сбросить пароль владельцу — иначе
    // носитель users.manage перехватил бы его учётку (privilege escalation).
    // Симметрично updateUser — общий хелпер бросает PublicActionError для is_owner.
    await assertNotOwner(data.id);

    const passwordHash = await hashPassword(data.password);
    const rows = await sql<{ id: string }[]>`
      UPDATE users SET password_hash = ${passwordHash}, updated_at = now()
      WHERE id = ${data.id}
      RETURNING id
    `;
    if (!rows[0]) {
      throw new PublicActionError('Пользователь не найден.');
    }

    // Ротация сессий цели: после сброса пароля старые сессии должны умереть
    // (иначе выданные ранее cookie остались бы валидными) — как в changePassword.
    await invalidateUserSessions(data.id);

    return {
      result: { id: data.id },
      revalidate: [USERS_PATH],
      audit: {
        // Новый пароль/хеш в аудит НЕ попадают — фиксируем лишь факт сброса.
        action: 'user.password.reset',
        entityType: 'user',
        entityId: data.id,
      },
    };
  },
});

// =============================================================================
// РОЛИ.
// =============================================================================

export const createRole = defineAction({
  permission: 'roles.manage',
  input: RoleCreateSchema,
  handler: async (data, _ctx: ActionCtx) => {
    const codes = filterKnownPermissions(data.permissionCodes);

    let roleId: string;
    try {
      roleId = await sql.begin(async (tx: TransactionSql) => {
        const rows = await tx<{ id: string }[]>`
          INSERT INTO roles (code, title, is_system)
          VALUES (${data.code}, ${data.title}, false)
          RETURNING id
        `;
        const id = rows[0]!.id;
        await setRolePermissions(tx, id, codes);
        return id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new PublicActionError('Роль с таким кодом уже существует.');
      }
      throw err;
    }

    return {
      result: { id: roleId },
      revalidate: [ROLES_PATH],
      audit: {
        action: 'role.create',
        entityType: 'role',
        entityId: roleId,
        after: { code: data.code, title: data.title, permissionCodes: codes },
      },
    };
  },
});

export const updateRole = defineAction({
  permission: 'roles.manage',
  input: RoleUpdateSchema,
  handler: async (data, _ctx: ActionCtx) => {
    const before = await sql<{ id: string; code: string; title: string; is_system: boolean }[]>`
      SELECT id, code, title, is_system FROM roles WHERE id = ${data.id} LIMIT 1
    `;
    if (!before[0]) {
      throw new PublicActionError('Роль не найдена.');
    }
    // Системную роль править можно (название/права), но НЕ её код — он неизменяем
    // в принципе (схема UpdateSchema его не принимает).
    const codes =
      data.permissionCodes !== undefined
        ? filterKnownPermissions(data.permissionCodes)
        : undefined;

    await sql.begin(async (tx: TransactionSql) => {
      await tx`
        UPDATE roles SET
          title      = COALESCE(${data.title ?? null}, title),
          updated_at = now()
        WHERE id = ${data.id}
      `;
      if (codes !== undefined) {
        await setRolePermissions(tx, data.id, codes);
      }
    });

    return {
      result: { id: data.id },
      revalidate: [ROLES_PATH],
      audit: {
        action: 'role.update',
        entityType: 'role',
        entityId: data.id,
        before: { title: before[0].title },
        after: {
          title: data.title ?? before[0].title,
          permissionCodes: codes,
        },
      },
    };
  },
});

export const deleteRole = defineAction({
  permission: 'roles.manage',
  input: RoleIdSchema,
  handler: async (data, _ctx: ActionCtx) => {
    const before = await sql<{ id: string; code: string; is_system: boolean }[]>`
      SELECT id, code, is_system FROM roles WHERE id = ${data.id} LIMIT 1
    `;
    if (!before[0]) {
      throw new PublicActionError('Роль не найдена.');
    }
    if (before[0].is_system) {
      throw new PublicActionError('Системную роль удалить нельзя.');
    }
    // ON DELETE CASCADE снимет привязки role_permissions и user_roles.
    await sql`DELETE FROM roles WHERE id = ${data.id}`;

    return {
      result: { id: data.id },
      revalidate: [ROLES_PATH],
      audit: {
        action: 'role.delete',
        entityType: 'role',
        entityId: data.id,
        before: { code: before[0].code },
      },
    };
  },
});
