import Link from 'next/link';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { listUsersWithRoles } from '@/lib/auth/admin-repository';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';

/**
 * Раздел «Пользователи» (docs/04 §6.1). Список под правом 'users.read';
 * создание/редактирование/отключение — под 'users.manage' (проверяется в
 * Server Action). Кнопки управления показываем только при наличии права.
 *
 * force-dynamic: читает БД и сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

/** Подпись статуса для владельца магазина (без тех-жаргона). */
const STATUS_LABELS: Record<string, string> = {
  active: 'Активен',
  disabled: 'Отключён',
  invited: 'Приглашён',
};

export default async function UsersPage() {
  const user = await requireUser();
  if (!can(user, 'users.read')) {
    return <Forbidden permission="users.read" />;
  }
  const canManage = can(user, 'users.manage');

  const users = await listUsersWithRoles();

  return (
    <div>
      <PageHeader
        title="Пользователи"
        subtitle="Сотрудники с доступом в админку и их роли."
        breadcrumbs={[{ label: 'Пользователи' }]}
        action={
          canManage ? (
            <Link
              href="/admin/users/new"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              + Создать пользователя
            </Link>
          ) : null
        }
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Email</th>
              <th scope="col" className="px-4 py-2 font-medium">Имя</th>
              <th scope="col" className="px-4 py-2 font-medium">Статус</th>
              <th scope="col" className="px-4 py-2 font-medium">Роли</th>
              <th scope="col" className="px-4 py-2 font-medium">Владелец</th>
              {canManage ? <th scope="col" className="px-4 py-2 font-medium" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 6 : 5} className="px-4 py-6 text-center text-gray-400">
                  Пользователей пока нет.
                </td>
              </tr>
            ) : (
              users.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2 text-gray-800">{row.email}</td>
                  <td className="px-4 py-2 text-gray-600">{row.displayName || '—'}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {STATUS_LABELS[row.status] ?? row.status}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {row.roles.length === 0 ? '—' : row.roles.map((r) => r.title).join(', ')}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{row.isOwner ? 'да' : '—'}</td>
                  {canManage ? (
                    <td className="px-4 py-2 text-right">
                      {row.isOwner ? (
                        <span className="text-xs text-gray-400">защищён</span>
                      ) : (
                        <Link
                          href={`/admin/users/${row.id}`}
                          className="text-sm text-blue-700 hover:underline"
                        >
                          Редактировать
                        </Link>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
