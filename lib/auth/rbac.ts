/**
 * Чистая логика проверки доступа RBAC (docs/04 §5.3, §5.4; ADR-005).
 *
 * Проверки идут ПО ПРАВАМ (`can(user, 'orders.write')`), не по именам ролей.
 * Это серверный источник решений о доступе: скрытие пунктов в UI защитой
 * не является (критерий DoD, §5.3 «двойная защита»).
 *
 * Получение текущего пользователя из сессии (`getCurrentUser` / `requireUser`)
 * здесь НЕ реализуется — оно зависит от слоя сессий и будет в
 * `lib/auth/session.ts` (задача session-агента, docs/04 §5.3).
 */

import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Аутентифицированный пользователь с предвычисленными эффективными правами.
 * `permissions` = объединение прав всех ролей пользователя (см. buildPermissionSet).
 */
export interface AuthUser {
  id: string;
  email: string;
  /** Супер-владелец: проходит все проверки прав безусловно (§5.4). */
  isOwner: boolean;
  /** Эффективные права = объединение прав всех ролей пользователя. */
  permissions: Set<PermissionCode>;
}

/**
 * Ошибка отказа в доступе. Несёт HTTP-статус 403 для слоя Server Actions/роутов.
 */
export class ForbiddenError extends Error {
  /** Машиночитаемый код ошибки. */
  readonly code = 'FORBIDDEN' as const;
  /** HTTP-статус для отдачи клиенту. */
  readonly status = 403 as const;
  /** Право, которого не хватило (для логирования/диагностики). */
  readonly permission?: PermissionCode;

  constructor(permission?: PermissionCode) {
    super(
      permission
        ? `Доступ запрещён: требуется право «${permission}».`
        : 'Доступ запрещён.',
    );
    this.name = 'ForbiddenError';
    this.permission = permission;
    // Корректная цепочка прототипов при компиляции в ES5/ES2015+.
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

/**
 * Базовая проверка доступа (чистая функция).
 * Владелец (`isOwner`) проходит всегда; иначе — наличие права в множестве.
 */
export function can(user: AuthUser, perm: PermissionCode): boolean {
  return user.isOwner || user.permissions.has(perm);
}

/**
 * Гвард для Server Actions / loaders: бросает ForbiddenError, если права нет.
 */
export function requirePermission(user: AuthUser, perm: PermissionCode): void {
  if (!can(user, perm)) {
    throw new ForbiddenError(perm);
  }
}

/**
 * Строит множество эффективных прав из набора ролей пользователя.
 * Объединяет права всех ролей без дублей (Set).
 */
export function buildPermissionSet(
  roles: { permissions: PermissionCode[] }[],
): Set<PermissionCode> {
  const result = new Set<PermissionCode>();
  for (const role of roles) {
    for (const perm of role.permissions) {
      result.add(perm);
    }
  }
  return result;
}

// Примечание: `getCurrentUser()` и `requireUser()` (получение AuthUser из
// сессии/cookie с редиректом на /admin/login) будут реализованы в
// lib/auth/session.ts — они зависят от слоя сессий (docs/04 §5.3).
