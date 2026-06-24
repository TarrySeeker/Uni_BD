import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард страниц CMS (docs/11 §5.1.5): решение о доступе принимается
 * ТОЛЬКО на сервере (образец guardCatalog). Проверяет:
 *  1) включён ли модуль `cms` — иначе раздела нет (выключенный модуль не отдаёт UI);
 *  2) аутентификацию (requireUser → редирект на /admin/login при отсутствии);
 *  3) наличие требуемого права (cms.read для чтения, cms.write для мутаций).
 *
 * Скрытие пункта в меню (nav.ts) защитой не является — настоящий гейт здесь и в
 * Server Actions (assertCmsEnabled + permission 'cms.write').
 */
export type CmsGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'module_disabled' }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardCms(
  permission: PermissionCode = 'cms.read',
): Promise<CmsGuardResult> {
  if (!(await isModuleEffectivelyEnabled('cms'))) {
    return { ok: false, reason: 'module_disabled' };
  }
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
