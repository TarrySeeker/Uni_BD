import { notFound } from 'next/navigation';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { getRoleById } from '@/lib/auth/admin-repository';
import { isSingleUserModeEnabled } from '@/lib/config/settings';

import { Forbidden } from '../../_components/Forbidden';
import { SingleUserModeNotice } from '../../_components/SingleUserModeNotice';
import { PageHeader } from '../../_components/PageHeader';
import { RoleForm } from '../_components/RoleForm';

/**
 * Карточка роли (docs/04 §6.1). Доступ — roles.manage; правки — через updateRole.
 * Системную роль можно редактировать (название/права), но не её код.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!can(user, 'roles.manage')) {
    return <Forbidden permission="roles.manage" />;
  }
  // Однопользовательский режим (B9): управление ролями отключено.
  if (await isSingleUserModeEnabled()) {
    return <SingleUserModeNotice kind="roles" />;
  }

  const { id } = await params;
  const role = await getRoleById(id);
  if (!role) {
    notFound();
  }

  return (
    <div>
      <PageHeader
        title={role.title}
        subtitle={role.isSystem ? 'Системная роль' : undefined}
        breadcrumbs={[
          { label: 'Роли', href: '/admin/roles' },
          { label: role.title },
        ]}
        backHref="/admin/roles"
        backLabel="К списку"
      />

      <div className="mt-6">
        <RoleForm role={role} />
      </div>
    </div>
  );
}
