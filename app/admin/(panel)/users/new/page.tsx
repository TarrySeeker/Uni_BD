import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { listRolesWithPermissionCounts } from '@/lib/auth/admin-repository';
import { isSingleUserModeEnabled } from '@/lib/config/settings';

import { Forbidden } from '../../_components/Forbidden';
import { SingleUserModeNotice } from '../../_components/SingleUserModeNotice';
import { PageHeader } from '../../_components/PageHeader';
import { UserForm } from '../_components/UserForm';

/**
 * Создание пользователя (docs/04 §6.1). Доступ — users.manage; создаёт через
 * createUser. Список ролей грузим для чекбоксов формы.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewUserPage() {
  const t = await getTranslations();
  const user = await requireUser();
  if (!can(user, 'users.manage')) {
    return <Forbidden permission="users.manage" />;
  }
  // Однопользовательский режим (B9): создание пользователей отключено.
  if (await isSingleUserModeEnabled()) {
    return <SingleUserModeNotice kind="users" />;
  }

  const roles = await listRolesWithPermissionCounts();

  return (
    <div>
      <PageHeader
        title={t('users.newPage.title')}
        subtitle={t('users.newPage.subtitle')}
        breadcrumbs={[
          { label: t('nav.users'), href: '/admin/users' },
          { label: t('users.newPage.title') },
        ]}
        backHref="/admin/users"
        backLabel={t('users.newPage.backToList')}
      />

      <div className="mt-6">
        <UserForm
          user={null}
          roles={roles.map((r) => ({ id: r.id, code: r.code, title: r.title }))}
        />
      </div>
    </div>
  );
}
