import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард раздела «Доставка (СДЭК)» (порт guardOrders). Решение о доступе
 * принимается ТОЛЬКО на сервере (скрытие пункта меню защитой не является):
 *  1) включён ли модуль `cdek` — иначе раздела нет (как в nav.ts);
 *  2) аутентификация (requireUser → редирект на /admin/login при отсутствии);
 *  3) право (по умолчанию `cdek.manage`).
 */
export type CdekGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'module_disabled' }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardCdek(
  permission: PermissionCode = 'cdek.manage',
): Promise<CdekGuardResult> {
  if (!(await isModuleEffectivelyEnabled('cdek'))) {
    return { ok: false, reason: 'module_disabled' };
  }
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
