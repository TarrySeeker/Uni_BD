/**
 * Каталог прав и базовых ролей RBAC как данные (ADR-005, docs/04 §5.2).
 *
 * Эти структуры — единый источник правды о наборе прав платформы и о составе
 * системных ролей. Их использует seed-агент (генерирует SQL для таблиц
 * `permissions` / `roles` / `role_permissions` или читает напрямую), а также
 * типобезопасная логика проверки доступа в `lib/auth/rbac.ts`.
 *
 * Принцип универсальности (ADR-003): права и роли описаны ДАННЫМИ, проверки в
 * коде идут по кодам прав, а не по именам ролей. Новый модуль добавляет права
 * строкой здесь + в seed, без правки логики проверок.
 */

import type { ModuleName } from '@/lib/config/modules';

/**
 * Все коды прав платформы. Формат: `<домен>.<действие>` (docs/04 §5.2).
 * Любой код прав в системе должен присутствовать в этом объединении.
 */
export type PermissionCode =
  | 'users.read'
  | 'users.manage'
  | 'roles.manage'
  | 'audit.read'
  | 'settings.manage'
  | 'catalog.read'
  | 'catalog.write'
  | 'orders.read'
  | 'orders.write'
  | 'cdek.manage'
  | 'cms.read'
  | 'cms.write';

/** Описание одного права для seed и UI. */
export interface PermissionDef {
  code: PermissionCode;
  title: string;
  /** Модуль, к которому относится право: 'core' либо один из модулей платформы. */
  module: 'core' | ModuleName;
}

/**
 * Полный каталог прав Этапа 1 (docs/04 §5.2). Права модулей сидируются всегда,
 * но в меню/UI отражаются только при включённом модуле (`isModuleEnabled`).
 */
export const ALL_PERMISSIONS: readonly PermissionDef[] = [
  { code: 'users.read', title: 'Просмотр пользователей', module: 'core' },
  { code: 'users.manage', title: 'Управление пользователями', module: 'core' },
  { code: 'roles.manage', title: 'Управление ролями и привязкой прав', module: 'core' },
  { code: 'audit.read', title: 'Просмотр журнала аудита', module: 'core' },
  { code: 'settings.manage', title: 'Управление настройками магазина', module: 'core' },
  { code: 'catalog.read', title: 'Просмотр каталога', module: 'catalog' },
  { code: 'catalog.write', title: 'Изменение каталога', module: 'catalog' },
  { code: 'orders.read', title: 'Просмотр заказов', module: 'orders' },
  { code: 'orders.write', title: 'Изменение заказов', module: 'orders' },
  { code: 'cdek.manage', title: 'Управление доставкой СДЭК', module: 'cdek' },
  { code: 'cms.read', title: 'Просмотр контента', module: 'cms' },
  { code: 'cms.write', title: 'Изменение контента', module: 'cms' },
] as const;

/** Код системной роли (docs/04 §5.2). Системные роли неудаляемы (is_system). */
export type SystemRoleCode = 'owner' | 'admin' | 'manager';

/** Определение системной роли как набора прав. */
export interface SystemRoleDef {
  code: SystemRoleCode;
  title: string;
  permissions: PermissionCode[];
}

/**
 * Системные роли (seed, `is_system = true`), docs/04 §5.2.
 *
 * Эффективные права пользователя = объединение прав всех его ролей, плюс
 * безусловное «всё» для `is_owner` (короткое замыкание в `can`, §5.4).
 */
export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    code: 'owner',
    title: 'Владелец',
    // Намеренно пустой набор: пользователь-владелец помечается `is_owner = true`
    // и проходит ВСЕ проверки прав за счёт короткого замыкания в `can()` (§5.4).
    // Привязка прав к роли `owner` не требуется — она лишь маркер для seed/UI.
    permissions: [],
  },
  {
    code: 'admin',
    title: 'Администратор',
    // Все read + write/manage по всем доменам (core/catalog/orders/cms/cdek).
    permissions: [
      'users.read',
      'users.manage',
      'roles.manage',
      'audit.read',
      'settings.manage',
      'catalog.read',
      'catalog.write',
      'orders.read',
      'orders.write',
      'cdek.manage',
      'cms.read',
      'cms.write',
    ],
  },
  {
    code: 'manager',
    title: 'Менеджер',
    // Операционная работа: заказы (чтение/запись), каталог (чтение),
    // доставка СДЭК, чтение аудита.
    permissions: [
      'orders.read',
      'orders.write',
      'catalog.read',
      'cdek.manage',
      'audit.read',
    ],
  },
] as const;

/**
 * Человеко-понятное название права по коду (для UI: «403», списки ролей и т.п.).
 * Неизвестный код возвращается как есть (фолбэк для нестандартных строк).
 */
const PERMISSION_TITLE_BY_CODE = new Map<string, string>(
  ALL_PERMISSIONS.map((p) => [p.code, p.title]),
);
export function permissionTitle(code: string): string {
  return PERMISSION_TITLE_BY_CODE.get(code) ?? code;
}
