import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { listUsersWithRoles } from '@/lib/auth/admin-repository';
import { formatDateTime } from '@/lib/admin/order-format';
import { getShopTimeZone } from '@/lib/admin/timezone';
import { isSingleUserModeEnabled } from '@/lib/config/settings';

import { Forbidden } from '../_components/Forbidden';
import { SingleUserModeNotice } from '../_components/SingleUserModeNotice';
import { PageHeader } from '../_components/PageHeader';

/**
 * Раздел «Пользователи» (docs/04 §6.1). Список под правом 'users.read';
 * создание/редактирование/отключение — под 'users.manage' (проверяется в
 * Server Action). Кнопки управления показываем только при наличии права.
 *
 * force-dynamic: читает БД и сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const t = await getTranslations();
  // Пояс магазина — один на всю админку (аудит major №26).
  const timeZone = await getShopTimeZone();
  const statusLabel = (status: string) => {
    if (status === 'active') return t('common.states.active');
    if (status === 'disabled') return t('common.states.disabled');
    if (status === 'invited') return t('users.page.statusInvited');
    return status;
  };
  const user = await requireUser();
  if (!can(user, 'users.read')) {
    return <Forbidden permission="users.read" />;
  }
  // Однопользовательский режим (B9): прямой заход по URL → заглушка вместо списка.
  if (await isSingleUserModeEnabled()) {
    return <SingleUserModeNotice kind="users" />;
  }
  const canManage = can(user, 'users.manage');

  const users = await listUsersWithRoles();

  return (
    <div>
      <PageHeader
        title={t('nav.users')}
        subtitle={t('users.page.subtitle')}
        breadcrumbs={[{ label: t('nav.users') }]}
        action={
          canManage ? (
            <Link
              href="/admin/users/new"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              {t('users.page.createButton')}
            </Link>
          ) : null
        }
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">{t('users.page.colEmail')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('fields.name')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('users.page.colStatus')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('nav.roles')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('users.page.colLastLogin')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('users.page.colOwner')}</th>
              {canManage ? <th scope="col" className="px-4 py-2 font-medium" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 7 : 6} className="px-4 py-6 text-center text-gray-400">
                  {t('users.page.empty')}
                </td>
              </tr>
            ) : (
              users.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2 text-gray-800">{row.email}</td>
                  <td className="px-4 py-2 text-gray-600">{row.displayName || '—'}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {statusLabel(row.status)}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {row.roles.length === 0 ? '—' : row.roles.map((r) => r.title).join(', ')}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatDateTime(row.lastLoginAt, timeZone)}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{row.isOwner ? t('users.page.yes') : '—'}</td>
                  {canManage ? (
                    <td className="px-4 py-2 text-right">
                      {row.isOwner ? (
                        <span className="text-xs text-gray-400">{t('users.page.protected')}</span>
                      ) : (
                        <Link
                          href={`/admin/users/${row.id}`}
                          className="text-sm text-blue-700 hover:underline"
                        >
                          {t('common.actions.edit')}
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
