import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';

import { Forbidden } from '../../_components/Forbidden';
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

  return (
    <div>
      <PageHeader
        title="Новая роль"
        subtitle="Задайте набор прав, который получат сотрудники с этой ролью."
        breadcrumbs={[
          { label: 'Роли', href: '/admin/roles' },
          { label: 'Новая роль' },
        ]}
        backHref="/admin/roles"
        backLabel="К списку"
      />

      <div className="mt-6">
        <RoleForm role={null} />
      </div>
    </div>
  );
}
