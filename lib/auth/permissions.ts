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
  | 'cms.write'
  | 'news.read'
  | 'news.write'
  | 'reviews.read'
  | 'reviews.write'
  | 'gift.read'
  | 'gift.write'
  | 'customers.read'
  | 'customers.write'
  | 'i18n.read'
  | 'i18n.manage';

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
  { code: 'users.read', title: 'permissions.titles.usersRead', module: 'core' },
  { code: 'users.manage', title: 'permissions.titles.usersManage', module: 'core' },
  { code: 'roles.manage', title: 'permissions.titles.rolesManage', module: 'core' },
  { code: 'audit.read', title: 'permissions.titles.auditRead', module: 'core' },
  { code: 'settings.manage', title: 'permissions.titles.settingsManage', module: 'core' },
  { code: 'catalog.read', title: 'permissions.titles.catalogRead', module: 'catalog' },
  { code: 'catalog.write', title: 'permissions.titles.catalogWrite', module: 'catalog' },
  { code: 'orders.read', title: 'permissions.titles.ordersRead', module: 'orders' },
  { code: 'orders.write', title: 'permissions.titles.ordersWrite', module: 'orders' },
  { code: 'cdek.manage', title: 'permissions.titles.cdekManage', module: 'cdek' },
  { code: 'cms.read', title: 'permissions.titles.cmsRead', module: 'cms' },
  { code: 'cms.write', title: 'permissions.titles.cmsWrite', module: 'cms' },
  { code: 'news.read', title: 'permissions.titles.newsRead', module: 'news' },
  { code: 'news.write', title: 'permissions.titles.newsWrite', module: 'news' },
  { code: 'reviews.read', title: 'permissions.titles.reviewsRead', module: 'reviews' },
  { code: 'reviews.write', title: 'permissions.titles.reviewsWrite', module: 'reviews' },
  // Подарочные сертификаты — часть операционного модуля orders (отдельного
  // модуля gift на платформе нет; данные живут в orders/gift-миграциях).
  { code: 'gift.read', title: 'permissions.titles.giftRead', module: 'orders' },
  { code: 'gift.write', title: 'permissions.titles.giftWrite', module: 'orders' },
  { code: 'customers.read', title: 'permissions.titles.customersRead', module: 'account' },
  { code: 'customers.write', title: 'permissions.titles.customersWrite', module: 'account' },
  // i18n — сквозной core-слой (всегда включён), не отдельный переключаемый модуль.
  { code: 'i18n.read', title: 'permissions.titles.i18nRead', module: 'core' },
  { code: 'i18n.manage', title: 'permissions.titles.i18nManage', module: 'core' },
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
    // Все read + write/manage по всем доменам платформы. Инвариант: admin держит
    // ВЕСЬ ALL_PERMISSIONS (проверяется тестом полноты) — новый код права здесь
    // обязателен, иначе он остаётся «сиротой» без роли.
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
      'news.read',
      'news.write',
      'reviews.read',
      'reviews.write',
      'gift.read',
      'gift.write',
      'customers.read',
      'customers.write',
      'i18n.read',
      'i18n.manage',
    ],
  },
  {
    code: 'manager',
    title: 'Менеджер',
    // Операционная работа: заказы (чтение/запись), каталог (чтение),
    // доставка СДЭК, чтение аудита, модерация отзывов и чтение покупателей.
    permissions: [
      'orders.read',
      'orders.write',
      'catalog.read',
      'cdek.manage',
      'audit.read',
      'reviews.read',
      'reviews.write',
      'customers.read',
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
export function permissionTitle(
  code: string,
  t: (key: string) => string,
): string {
  const key = PERMISSION_TITLE_BY_CODE.get(code);
  return key ? t(key) : code;
}
