/**
 * Чистая логика состава меню админки = f(включённые модули, права) — docs/04 §6.3.
 *
 * Меню скрывает пункты по двум независимым причинам:
 *   - модуль выключен — раздел физически отсутствует в магазине;
 *   - у пользователя нет права (`can`) — доступа к разделу нет.
 *
 * Это лишь UI-фильтр для удобства; настоящее решение о доступе принимает сервер
 * (гварды Server Actions/роутов, §5.3 «двойная защита»). Скрытие в меню защитой
 * не является.
 *
 * Функция чистая и тестируемая: набор ЭФФЕКТИВНЫХ модулей (env ⊕ БД-оверрайд)
 * передаётся параметром `enabledModules`, поэтому фильтрация по модулям не зависит
 * ни от глобального `process.env`, ни от чтения БД внутри функции. Сам набор
 * вычисляет вызывающий (layout: getEffectiveModuleSet()) — так меню реагирует на
 * выключение модуля из UI, а не только на ADMIK_MODULES.
 */

import { can, type AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { type ModuleName } from '@/lib/config/modules';

/** Пункт навигации админки. */
export interface NavItem {
  href: string;
  label: string;
  /** Требуемое право; если не задано — доступно всем (напр. дашборд). */
  permission?: PermissionCode;
  /** Модуль, к которому относится пункт; если не задан — пункт ядра (core). */
  module?: ModuleName;
}

/**
 * Полный состав меню (docs/04 §6.3). Порядок фиксирован.
 *
 * - «Дашборд» — без права и без модуля (виден всегда).
 * - «Каталог/Заказы/Доставка/Контент» — модульные пункты (module + permission).
 * - «Пользователи/Роли/Аудит» — пункты ядра (только permission).
 *
 * На Этапе 1 реально существуют только Дашборд, Пользователи, Роли, Аудит;
 * модульные пункты — заготовки под Этапы 2–5, но логика фильтрации уже готова.
 */
export const NAV: NavItem[] = [
  { href: '/admin', label: 'Дашборд' },
  { href: '/admin/catalog', label: 'Каталог', permission: 'catalog.read', module: 'catalog' },
  { href: '/admin/orders', label: 'Заказы', permission: 'orders.read', module: 'orders' },
  { href: '/admin/promo', label: 'Промокоды', permission: 'orders.write', module: 'orders' },
  // «Заявки» — core (без module): сообщения с формы витрины; право orders.read (G-09).
  { href: '/admin/leads', label: 'Заявки', permission: 'orders.read' },
  // «Подписчики» — core: email-подписки из футера витрины; orders.read (G-12).
  { href: '/admin/subscribers', label: 'Подписчики', permission: 'orders.read' },
  { href: '/admin/cdek', label: 'Доставка', permission: 'cdek.manage', module: 'cdek' },
  { href: '/admin/cms', label: 'Контент', permission: 'cms.read', module: 'cms' },
  { href: '/admin/users', label: 'Пользователи', permission: 'users.read' },
  { href: '/admin/roles', label: 'Роли', permission: 'roles.manage' },
  { href: '/admin/audit', label: 'Аудит', permission: 'audit.read' },
  // «Настройки» — core (без module): не прячется за флагом, которым сам управляет
  // (self-lock guard, docs/11 §5.4.5). Виден при наличии settings.manage.
  { href: '/admin/settings', label: 'Настройки', permission: 'settings.manage' },
];

/** Опции построения меню. */
export interface AdminNavOptions {
  /**
   * Однопользовательский режим магазина (B9). Когда true — пункты «Пользователи»
   * и «Роли» скрываются из меню. Это лишь UI-фильтр для удобства; настоящая защита
   * — guard страниц + серверная блокировка мутаций (admin-actions). Дефолт OFF.
   */
  singleUserMode?: boolean;
}

/**
 * Пункты, скрываемые в однопользовательском режиме — по СТАБИЛЬНОМУ href (не по
 * подписи, которая локализуема). Управление пользователями и ролями инстансу
 * с единственным пользователем не нужно.
 */
const SINGLE_USER_HIDDEN_HREFS: ReadonlySet<string> = new Set(['/admin/users', '/admin/roles']);

/**
 * Строит видимое для пользователя меню.
 *
 * Пункт показывается, если выполнены ВСЕ условия:
 *   - нет модуля ИЛИ модуль входит в эффективный набор (`enabledModules.has(module)`);
 *   - нет права ИЛИ пользователь им обладает (`can(user, permission)`);
 *   - не скрыт однопользовательским режимом (`opts.singleUserMode`, B9).
 *
 * `enabledModules` — ЭФФЕКТИВНЫЙ набор модулей (env ⊕ БД-оверрайд), вычисленный
 * вызывающим (layout: getEffectiveModuleSet()). Функция остаётся чистой/детерми-
 * нированной: она не читает ни process.env, ни БД. Принимает Set или массив имён.
 */
export function buildAdminNav(
  user: AuthUser,
  enabledModules: ReadonlySet<ModuleName> | readonly ModuleName[],
  opts: AdminNavOptions = {},
): NavItem[] {
  const enabled =
    enabledModules instanceof Set
      ? enabledModules
      : new Set<ModuleName>(enabledModules as readonly ModuleName[]);
  return NAV.filter(
    (item) =>
      !(opts.singleUserMode && SINGLE_USER_HIDDEN_HREFS.has(item.href)) &&
      (!item.module || enabled.has(item.module)) &&
      (!item.permission || can(user, item.permission)),
  );
}
