import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард раздела «Подарочные сертификаты» (docs/24 §5). Решение о
 * доступе — ТОЛЬКО на сервере (как guardOrders):
 *  1) включён ли модуль orders — сертификаты живут под ним;
 *  2) аутентификация (requireUser);
 *  3) право gift.read (чтение) / gift.write (мутации).
 */
export type GiftGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'module_disabled' }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardGift(
  permission: PermissionCode = 'gift.read',
): Promise<GiftGuardResult> {
  if (!(await isModuleEffectivelyEnabled('orders'))) {
    return { ok: false, reason: 'module_disabled' };
  }
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
