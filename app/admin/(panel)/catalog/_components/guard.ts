import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард страниц каталога (docs/05 §5): решение о доступе принимается
 * ТОЛЬКО на сервере. Проверяет:
 *  1) включён ли модуль `catalog` — иначе раздела нет (404), как и в nav.ts;
 *  2) аутентификацию (requireUser → редирект на /admin/login при отсутствии);
 *  3) наличие требуемого права (catalog.read для чтения, catalog.write для мутаций).
 *
 * Возвращает дискриминированный результат, чтобы страница сама решила, что
 * рендерить (Forbidden / контент). Скрытие пункта в меню защитой не является.
 */
export type CatalogGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'module_disabled' }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardCatalog(
  permission: PermissionCode = 'catalog.read',
): Promise<CatalogGuardResult> {
  if (!(await isModuleEffectivelyEnabled('catalog'))) {
    return { ok: false, reason: 'module_disabled' };
  }
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
