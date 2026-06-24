import { requireUser } from '@/lib/auth/session';
import { can, type AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Гвард раздела «Заявки» (G-09). Заявки — core (не привязаны к модулю), читаются
 * правом orders.read (смежно с продажами). Решение о доступе — на сервере.
 */
export type LeadsGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; permission: PermissionCode };

export async function guardLeads(
  permission: PermissionCode = 'orders.read',
): Promise<LeadsGuardResult> {
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, permission };
  }
  return { ok: true, user };
}
