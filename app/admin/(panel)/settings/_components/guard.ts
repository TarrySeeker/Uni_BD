import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард раздела настроек (docs/11 §5.4.5). Решение о доступе — только
 * на сервере. «Настройки» — core-раздел (без модуля): не гейтится флагом
 * ADMIK_MODULES (иначе self-lock — раздел сам управляет оверрайдом модулей).
 * Проверяет лишь аутентификацию + право.
 *
 * Право по умолчанию — `settings.manage` (отдельного `settings.read` в каталоге
 * прав нет; чтение и запись настроек идут под единым `settings.manage`).
 */
export type SettingsGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardSettings(
  permission: PermissionCode = 'settings.manage',
): Promise<SettingsGuardResult> {
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
