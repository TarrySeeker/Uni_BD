/**
 * Zod-схемы входа для Server Actions управления пользователями и ролями
 * (docs/04 §6.1). Единый источник правды о форме входных данных — используется
 * и серверными мутациями (lib/auth/admin-actions), и клиентскими формами.
 *
 * Все мутации валидируются этими схемами внутри defineAction (§4.7): успешный
 * safeParse → бизнес-handler; иначе — структурированные fieldErrors в форму.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Переиспользуемые примитивы.
// -----------------------------------------------------------------------------

/** UUID-идентификатор сущности. */
const uuid = z.string().uuid();

/** Email: обрезаем пробелы, валидируем формат (в БД — citext UNIQUE). */
const emailSchema = z.string().trim().email('Укажите корректный email');

/** Отображаемое имя: до 200 символов, по умолчанию пусто (NOT NULL DEFAULT ''). */
const displayNameSchema = z.string().trim().max(200).optional().default('');

/** Пароль: минимум 8 символов (хешируется argon2id перед записью). */
const passwordSchema = z.string().min(8, 'Пароль не короче 8 символов');

/** Массив id ролей (привязка user_roles). */
const roleIdsSchema = z.array(uuid).optional().default([]);

/**
 * Код роли: латиница в нижнем регистре, начинается с буквы, длина 2..31.
 * Совпадает с UNIQUE-кодом roles.code (owner/admin/manager и пользовательские).
 */
const roleCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_-]{1,30}$/,
    'Код роли: латиница в нижнем регистре, начинается с буквы (2–31 символ)',
  );

/** Название роли (человекочитаемое): 1..100 символов. */
const roleTitleSchema = z.string().trim().min(1, 'Укажите название').max(100);

/** Коды прав, привязываемых к роли (role_permissions.permission_code). */
const permissionCodesSchema = z.array(z.string()).optional().default([]);

// -----------------------------------------------------------------------------
// Пользователи.
// -----------------------------------------------------------------------------

/** Создание пользователя: email + пароль обязательны; роли/статус — опц. */
export const UserCreateSchema = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  roleIds: roleIdsSchema,
  // При создании владельца не заводят через UI — только active/disabled.
  status: z.enum(['active', 'disabled']).optional().default('active'),
});
export type UserCreateInput = z.infer<typeof UserCreateSchema>;

/** Обновление пользователя: email не меняем (UNIQUE-логин), всё прочее — опц. */
export const UserUpdateSchema = z.object({
  id: uuid,
  displayName: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'disabled', 'invited']).optional(),
  roleIds: z.array(uuid).optional(),
});
export type UserUpdateInput = z.infer<typeof UserUpdateSchema>;

/** Сброс пароля пользователя. */
export const UserPasswordResetSchema = z.object({
  id: uuid,
  password: passwordSchema,
});
export type UserPasswordResetInput = z.infer<typeof UserPasswordResetSchema>;

/** Идентификатор пользователя (для точечных операций). */
export const UserIdSchema = z.object({ id: uuid });
export type UserIdInput = z.infer<typeof UserIdSchema>;

// -----------------------------------------------------------------------------
// Роли.
// -----------------------------------------------------------------------------

/** Создание роли (всегда is_system=false): код + название + набор прав. */
export const RoleCreateSchema = z.object({
  code: roleCodeSchema,
  title: roleTitleSchema,
  permissionCodes: permissionCodesSchema,
});
export type RoleCreateInput = z.infer<typeof RoleCreateSchema>;

/** Обновление роли: код неизменяем; правим название и/или набор прав. */
export const RoleUpdateSchema = z.object({
  id: uuid,
  title: roleTitleSchema.optional(),
  permissionCodes: z.array(z.string()).optional(),
});
export type RoleUpdateInput = z.infer<typeof RoleUpdateSchema>;

/** Идентификатор роли (для удаления). */
export const RoleIdSchema = z.object({ id: uuid });
export type RoleIdInput = z.infer<typeof RoleIdSchema>;
