'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { deleteRoleAction } from './form-actions';
import { errorMessage } from './action-result';

/**
 * Кнопка удаления роли в списке (только для не системных). С подтверждением:
 * удаление снимает привязки прав и снимает роль со всех пользователей
 * (ON DELETE CASCADE). Мутация — deleteRole (roles.manage на сервере).
 */
export function RoleDeleteButton({ id, title }: { id: string; title: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function remove() {
    if (!window.confirm(t('roles.roleDeleteButton.confirm', { title }))) {
      return;
    }
    setPending(true);
    const result = await deleteRoleAction({ id });
    setPending(false);
    if (result.ok) {
      router.refresh();
    } else {
      window.alert(errorMessage(result, t));
    }
  }

  return (
    <button
      type="button"
      onClick={remove}
      disabled={pending}
      className="text-sm text-red-600 hover:underline disabled:opacity-50"
    >
      {pending ? t('roles.roleDeleteButton.deleting') : t('common.actions.delete')}
    </button>
  );
}
