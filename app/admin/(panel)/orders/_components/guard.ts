import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард страниц заказов/промокодов (docs/07 §5): решение о доступе —
 * ТОЛЬКО на сервере (как guardCatalog). Проверяет по очереди:
 *  1) включён ли модуль `orders` — иначе раздела нет (как в nav.ts);
 *  2) аутентификацию (requireUser → редирект на /admin/login при отсутствии);
 *  3) право (orders.read для чтения, orders.write для мутаций/форм).
 *
 * Возвращает дискриминированный результат: страница сама рендерит Forbidden или
 * контент. Скрытие пункта меню защитой не является — это лишь UI-фильтр.
 */
export type OrdersGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'module_disabled' }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardOrders(
  permission: PermissionCode = 'orders.read',
): Promise<OrdersGuardResult> {
  if (!(await isModuleEffectivelyEnabled('orders'))) {
    return { ok: false, reason: 'module_disabled' };
  }
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
