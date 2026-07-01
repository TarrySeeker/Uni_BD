import { notFound } from 'next/navigation';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import {
  getUserById,
  listRolesWithPermissionCounts,
} from '@/lib/auth/admin-repository';
import { isSingleUserModeEnabled } from '@/lib/config/settings';

import { Forbidden } from '../../_components/Forbidden';
import { SingleUserModeNotice } from '../../_components/SingleUserModeNotice';
import { PageHeader } from '../../_components/PageHeader';
import { UserForm } from '../_components/UserForm';

/**
 * Карточка пользователя (docs/04 §6.1). Доступ — users.manage; правки/сброс
 * пароля — через updateUser/resetUserPassword. Учётка владельца защищена: её
 * не показываем для редактирования.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const current = await requireUser();
  if (!can(current, 'users.manage')) {
    return <Forbidden permission="users.manage" />;
  }
  // Однопользовательский режим (B9): управление пользователями отключено.
  if (await isSingleUserModeEnabled()) {
    return <SingleUserModeNotice kind="users" />;
  }

  const { id } = await params;
  const [user, roles] = await Promise.all([
    getUserById(id),
    listRolesWithPermissionCounts(),
  ]);
  if (!user) {
    notFound();
  }
  // Учётку владельца через UI не редактируем (RBAC §5.4) — показываем заглушку.
  if (user.isOwner) {
    return (
      <div>
        <PageHeader
          title={user.displayName || user.email}
          breadcrumbs={[
            { label: 'Пользователи', href: '/admin/users' },
            { label: user.email },
          ]}
          backHref="/admin/users"
          backLabel="К списку"
        />
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          Это учётная запись владельца магазина. Её нельзя изменять или отключать.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={user.displayName || user.email}
        subtitle={user.email}
        breadcrumbs={[
          { label: 'Пользователи', href: '/admin/users' },
          { label: user.email },
        ]}
        backHref="/admin/users"
        backLabel="К списку"
      />

      <div className="mt-6">
        <UserForm
          user={user}
          roles={roles.map((r) => ({ id: r.id, code: r.code, title: r.title }))}
        />
      </div>
    </div>
  );
}
