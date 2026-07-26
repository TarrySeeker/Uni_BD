import { requireUser } from '@/lib/auth/session';
import { can, type AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Гвард раздела «Покупатели» (docs/24 §6). Аккаунты покупателей — НЕ admin-
 * пользователи; раздел просмотра/поддержки под правом customers.read (модуль
 * account). Решение о доступе — на сервере (страница + гвард, «двойная защита»).
 *
 * ГРАНИЦА 7a: только просмотр. Правки паролей/статусов (customers.write) —
 * последующий шаг; здесь их нет.
 */
export type CustomersGuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; permission: PermissionCode };

export async function guardCustomers(
  permission: PermissionCode = 'customers.read',
): Promise<CustomersGuardResult> {
  const user = await requireUser();
  if (!can(user, permission)) {
    return { ok: false, permission };
  }
  return { ok: true, user };
}

/**
 * Ключ подписи статуса аккаунта покупателя в каталоге интерфейса
 * (`customers.status.*`). Возвращается КЛЮЧ, а не текст: подпись обязана следовать
 * локали оператора, а этот модуль о локали ничего не знает.
 *
 * Незнакомый статус → null: страница покажет сам код (как и раньше), но не
 * притворится, что перевод есть.
 */
export function customerStatusLabelKey(status: string): string | null {
  switch (status) {
    case 'guest':
    case 'active':
    case 'disabled':
      return `customers.status.${status}`;
    default:
      return null;
  }
}

/** CSS-класс бейджа статуса. */
export function customerStatusBadgeClass(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-800';
    case 'disabled':
      return 'bg-red-100 text-red-700';
    case 'guest':
    default:
      return 'bg-gray-100 text-gray-600';
  }
}
