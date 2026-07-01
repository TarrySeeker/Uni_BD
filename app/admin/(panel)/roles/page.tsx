import Link from 'next/link';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { listRolesWithPermissionCounts } from '@/lib/auth/admin-repository';
import { isSingleUserModeEnabled } from '@/lib/config/settings';

import { Forbidden } from '../_components/Forbidden';
import { SingleUserModeNotice } from '../_components/SingleUserModeNotice';
import { PageHeader } from '../_components/PageHeader';
import { RoleDeleteButton } from './_components/RoleDeleteButton';

/**
 * Раздел «Роли» (docs/04 §6.1). Список и управление — под правом 'roles.manage'.
 * Системные роли защищены от удаления (is_system); их можно редактировать
 * (название/права), но не код. Создание/правки — через Server Actions.
 *
 * force-dynamic: читает БД и сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const user = await requireUser();
  if (!can(user, 'roles.manage')) {
    return <Forbidden permission="roles.manage" />;
  }
  // Однопользовательский режим (B9): прямой заход по URL → заглушка вместо списка.
  if (await isSingleUserModeEnabled()) {
    return <SingleUserModeNotice kind="roles" />;
  }

  const roles = await listRolesWithPermissionCounts();

  return (
    <div>
      <PageHeader
        title="Роли"
        subtitle="Наборы прав для сотрудников. Системные роли удалить нельзя."
        breadcrumbs={[{ label: 'Роли' }]}
        action={
          <Link
            href="/admin/roles/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Создать роль
          </Link>
        }
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Название</th>
              <th scope="col" className="px-4 py-2 font-medium">Прав</th>
              <th scope="col" className="px-4 py-2 font-medium">Тип</th>
              <th scope="col" className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {roles.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                  Ролей пока нет.
                </td>
              </tr>
            ) : (
              roles.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2 text-gray-800">
                    {row.title}
                    <span className="ml-2 text-xs text-gray-400">{row.code}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{row.permissionCount}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {row.isSystem ? 'системная' : 'пользовательская'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-4">
                      <Link
                        href={`/admin/roles/${row.id}`}
                        className="text-sm text-blue-700 hover:underline"
                      >
                        Редактировать
                      </Link>
                      {row.isSystem ? (
                        <span className="text-xs text-gray-400">защищена</span>
                      ) : (
                        <RoleDeleteButton id={row.id} title={row.title} />
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
