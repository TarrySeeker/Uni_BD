'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { RoleRef, UserWithRoles } from '@/lib/auth/admin-repository';

import {
  createUserAction,
  updateUserAction,
  resetUserPasswordAction,
} from './form-actions';
import { errorMessage, fieldError } from './action-result';

/**
 * Форма пользователя (docs/04 §6.1). Создание/редактирование учётной записи,
 * назначение ролей, сброс пароля. Мутации — createUser/updateUser/
 * resetUserPassword (users.manage на сервере).
 *
 * Email на создании задаётся, на редактировании — только для просмотра (логин
 * неизменяем). Пароль на создании обязателен; на редактировании меняется
 * отдельной кнопкой «Сбросить пароль». Роли — чекбоксы по названию.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Подпись статуса для владельца магазина (без тех-жаргона). */
const STATUS_LABELS: Record<string, string> = {
  active: 'Активен',
  disabled: 'Отключён',
  invited: 'Приглашён',
};

export function UserForm({
  user,
  roles,
}: {
  user: UserWithRoles | null;
  roles: RoleRef[];
}) {
  const router = useRouter();
  const isEdit = user !== null;

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string>(user?.status ?? 'active');
  const [roleIds, setRoleIds] = useState<string[]>(
    user ? user.roles.map((r) => r.id) : [],
  );

  // Сброс пароля (только на редактировании).
  const [newPassword, setNewPassword] = useState('');

  function toggleRole(id: string) {
    setRoleIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = isEdit
      ? await updateUserAction({
          id: user!.id,
          displayName: displayName.trim(),
          status,
          roleIds,
        })
      : await createUserAction({
          email: email.trim(),
          displayName: displayName.trim(),
          password,
          status,
          roleIds,
        });
    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess('Сохранено.');
        router.refresh();
      } else {
        router.push('/admin/users');
      }
    } else {
      setError(result);
    }
  }

  async function resetPassword() {
    if (!isEdit) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await resetUserPasswordAction({
      id: user!.id,
      password: newPassword,
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Пароль обновлён.');
      setNewPassword('');
    } else {
      setError(result);
    }
  }

  function fe(f: string) {
    return fieldError(error, f);
  }

  // Статусы, доступные для выбора: на создании — без «Приглашён».
  const statusOptions = isEdit
    ? (['active', 'disabled', 'invited'] as const)
    : (['active', 'disabled'] as const);

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
          <label htmlFor="u-email" className="block text-sm font-medium text-gray-700">Email*</label>
          <input
            id="u-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={isEdit}
            className={`mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm ${isEdit ? 'bg-gray-100 text-gray-500' : ''}`}
            required={!isEdit}
          />
          {isEdit ? (
            <p className="mt-1 text-xs text-gray-400">Email (логин) изменить нельзя.</p>
          ) : null}
          {fe('email') ? <p className="mt-1 text-xs text-red-600">{fe('email')}</p> : null}
        </div>

        <div>
          <label htmlFor="u-name" className="block text-sm font-medium text-gray-700">Имя</label>
          <input
            id="u-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          {fe('displayName') ? <p className="mt-1 text-xs text-red-600">{fe('displayName')}</p> : null}
        </div>

        {!isEdit ? (
          <div>
            <label htmlFor="u-pass" className="block text-sm font-medium text-gray-700">Пароль*</label>
            <input
              id="u-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="не короче 8 символов"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              required
            />
            {fe('password') ? <p className="mt-1 text-xs text-red-600">{fe('password')}</p> : null}
          </div>
        ) : null}

        <div>
          <label htmlFor="u-status" className="block text-sm font-medium text-gray-700">Статус</label>
          <select
            id="u-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          {fe('status') ? <p className="mt-1 text-xs text-red-600">{fe('status')}</p> : null}
        </div>

        <div className="lg:col-span-2">
          <span className="block text-sm font-medium text-gray-700">Роли</span>
          {roles.length === 0 ? (
            <p className="mt-1 text-sm text-gray-400">Ролей пока нет — создайте их в разделе «Роли».</p>
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {roles.map((role) => (
                <label key={role.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={roleIds.includes(role.id)}
                    onChange={() => toggleRole(role.id)}
                  />
                  {role.title}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать пользователя'}
        </button>
        <button type="button" onClick={() => router.push('/admin/users')}
          className="text-sm text-gray-600 hover:underline">
          Отмена
        </button>
      </div>

      {isEdit ? (
        <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h2 className="text-sm font-semibold text-gray-800">Сбросить пароль</h2>
          <p className="mt-1 text-xs text-gray-500">
            Задайте новый пароль для входа сотрудника. Старый перестанет работать.
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="u-newpass" className="block text-xs font-medium text-gray-600">Новый пароль</label>
              <input
                id="u-newpass"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="не короче 8 символов"
                className="mt-1 w-64 rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <button type="button" onClick={resetPassword} disabled={pending || newPassword.length < 8}
              className="rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
              Сбросить пароль
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
