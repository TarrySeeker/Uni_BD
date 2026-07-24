import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { isSingleUserModeEnabled } from '@/lib/config/settings';

import { Forbidden } from '../../_components/Forbidden';
import { SingleUserModeNotice } from '../../_components/SingleUserModeNotice';
import { PageHeader } from '../../_components/PageHeader';
import { RoleForm } from '../_components/RoleForm';

/**
 * Создание роли (docs/04 §6.1). Доступ — roles.manage; создаёт через createRole
 * (всегда is_system=false). Права выбираются чекбоксами по модулям.
 *
 * force-dynamic: читает cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewRolePage() {
  const user = await requireUser();
  if (!can(user, 'roles.manage')) {
    return <Forbidden permission="roles.manage" />;
  }
  // Однопользовательский режим (B9): управление ролями отключено.
  if (await isSingleUserModeEnabled()) {
    return <SingleUserModeNotice kind="roles" />;
  }

  const t = await getTranslations();

  return (
    <div>
      <PageHeader
        title={t('roles.newPage.title')}
        subtitle={t('roles.newPage.subtitle')}
        breadcrumbs={[
          { label: t('nav.roles'), href: '/admin/roles' },
          { label: t('roles.newPage.title') },
        ]}
        backHref="/admin/roles"
        backLabel={t('roles.newPage.backToList')}
      />

      <div className="mt-6">
        <RoleForm role={null} />
      </div>
    </div>
  );
}
