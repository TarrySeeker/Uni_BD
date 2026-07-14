import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Серверный гвард страниц «Отзывы» (docs/24 §4, образец guardNews). Решение о
 * доступе — ТОЛЬКО на сервере: 1) включён ли модуль `reviews`; 2) аутентификация;
 * 3) требуемое право (reviews.read для чтения, reviews.write для модерации).
 * Скрытие пункта в меню (nav.ts) защитой не является — настоящий гейт здесь и в
 * Server Actions.
 */
export type ReviewsGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'module_disabled' }
  | { ok: false; reason: 'forbidden'; permission: PermissionCode };

export async function guardReviews(
  permission: PermissionCode = 'reviews.read',
): Promise<ReviewsGuardResult> {
  if (!(await isModuleEffectivelyEnabled('reviews'))) {
    return { ok: false, reason: 'module_disabled' };
  }
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, reason: 'forbidden', permission };
  }
  return { ok: true, user };
}
