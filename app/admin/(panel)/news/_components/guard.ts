import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард страниц «Новости» (docs/24 §3, образец guardCms). Решение о
 * доступе — ТОЛЬКО на сервере: 1) включён ли модуль `news`; 2) аутентификация;
 * 3) требуемое право (news.read для чтения, news.write для мутаций). Скрытие пункта
 * в меню (nav.ts) защитой не является — настоящий гейт здесь и в Server Actions.
 */
export type NewsGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'module_disabled' }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardNews(
  permission: PermissionCode = 'news.read',
): Promise<NewsGuardResult> {
  if (!(await isModuleEffectivelyEnabled('news'))) {
    return { ok: false, reason: 'module_disabled' };
  }
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
