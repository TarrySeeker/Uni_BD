'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';
import { ALL_PERMISSIONS, type PermissionDef } from '@/lib/auth/permissions';
import type { RoleWithPermissions } from '@/lib/auth/admin-repository';

import { createRoleAction, updateRoleAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';

/**
 * Форма роли (docs/04 §6.1). Создание/редактирование роли и набора её прав.
 * Мутации — createRole/updateRole (roles.manage на сервере).
 *
 * Код роли на создании задаётся, на редактировании — только для просмотра
 * (неизменяем). Системную роль править можно (название/права), но не код. Права
 * — чекбоксы, сгруппированные по модулю (ALL_PERMISSIONS + человекочитаемые
 * подписи из самого каталога прав).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Модули с человекочитаемыми подписями (см. roles.roleForm.modules.*). */
const KNOWN_MODULES = ['core', 'catalog', 'orders', 'cdek', 'cms'];

export function RoleForm({ role }: { role: RoleWithPermissions | null }) {
  const t = useTranslations();
  const router = useRouter();

  function moduleLabel(module: string): string {
    return KNOWN_MODULES.includes(module) ? t(`roles.roleForm.modules.${module}`) : module;
  }
  const isEdit = role !== null;

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [code, setCode] = useState(role?.code ?? '');
  const [title, setTitle] = useState(role?.title ?? '');
  const [permissionCodes, setPermissionCodes] = useState<string[]>(
    role ? [...role.permissionCodes] : [],
  );

  // Группировка прав по модулю (в порядке появления в каталоге прав).
  const groups = useMemo(() => {
    const map = new Map<string, PermissionDef[]>();
    for (const perm of ALL_PERMISSIONS) {
      const list = map.get(perm.module) ?? [];
      list.push(perm);
      map.set(perm.module, list);
    }
    return [...map.entries()];
  }, []);

  function togglePermission(permCode: string) {
    setPermissionCodes((prev) =>
      prev.includes(permCode) ? prev.filter((x) => x !== permCode) : [...prev, permCode],
    );
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = isEdit
      ? await updateRoleAction({
          id: role!.id,
          title: title.trim(),
          permissionCodes,
        })
      : await createRoleAction({
          code: code.trim(),
          title: title.trim(),
          permissionCodes,
        });
    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess(t('common.form.saved'));
        router.refresh();
      } else {
        router.push('/admin/roles');
      }
    } else {
      setError(result);
    }
  }

  function fe(f: string) {
    return fieldError(error, f);
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="r-code" className="block text-sm font-medium text-gray-700">{t('roles.roleForm.codeLabel')}</label>
          <input
            id="r-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            readOnly={isEdit}
            placeholder={t('roles.roleForm.codePlaceholder')}
            className={`mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm ${isEdit ? 'bg-gray-100 text-gray-500' : ''}`}
            required={!isEdit}
          />
          {isEdit ? (
            <p className="mt-1 text-xs text-gray-400">
              {t('roles.roleForm.codeReadonlyHint')}{role!.isSystem ? ` ${t('roles.roleForm.systemRoleNote')}` : ''}
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-400">
              {t('roles.roleForm.codeHint')}
            </p>
          )}
          {fe('code') ? <p className="mt-1 text-xs text-red-600">{fe('code')}</p> : null}
        </div>

        <div>
          <label htmlFor="r-title" className="block text-sm font-medium text-gray-700">{t('roles.roleForm.titleLabel')}</label>
          <input
            id="r-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('roles.roleForm.titlePlaceholder')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            required
          />
          {fe('title') ? <p className="mt-1 text-xs text-red-600">{fe('title')}</p> : null}
        </div>
      </div>

      <div className="mt-6">
        <span className="block text-sm font-medium text-gray-700">{t('roles.roleForm.permissionsLegend')}</span>
        <p className="mt-1 text-xs text-gray-400">
          {t('roles.roleForm.permissionsHint')}
        </p>
        <div className="mt-3 space-y-4">
          {groups.map(([module, perms]) => (
            <fieldset key={module} className="rounded-lg border border-gray-200 p-4">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {moduleLabel(module)}
              </legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {perms.map((perm) => (
                  <label key={perm.code} className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={permissionCodes.includes(perm.code)}
                      onChange={() => togglePermission(perm.code)}
                    />
                    {t(perm.title)}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : isEdit ? t('common.actions.save') : t('roles.roleForm.createButton')}
        </button>
        <button type="button" onClick={() => router.push('/admin/roles')}
          className="text-sm text-gray-600 hover:underline">
          {t('common.actions.cancel')}
        </button>
      </div>
    </div>
  );
}
