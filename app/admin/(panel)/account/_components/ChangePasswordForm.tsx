'use client';

import { useState } from 'react';

import { changePassword, type ChangePasswordResult } from '@/lib/auth/actions';

/**
 * Форма смены СОБСТВЕННОГО пароля (профиль текущего пользователя).
 *
 * Вызывает готовый Server Action `changePassword` (lib/auth/actions) НАПРЯМУЮ —
 * без дублирования логики. Экшен сам:
 *   - делает requireUser() (любой залогиненный меняет только свой пароль);
 *   - проверяет ТЕКУЩИЙ пароль (verify против хеша);
 *   - валидирует длину нового (≥ 8) и хеширует argon2id;
 *   - после смены гасит ВСЕ сессии пользователя (ротация) → нужен повторный вход.
 *
 * Поэтому при успехе показываем сообщение о том, что текущая сессия завершена, и
 * предлагаем войти заново: следующий запрос к админке всё равно отправит на /login.
 *
 * UI повторяет стиль форм админки (inputCls/labelCls, role=alert/role=status,
 * disabled при pending). Подтверждение пароля проверяется на клиенте до отправки —
 * сервер про confirm не знает и знать не должен (поле существует только в UI).
 */

const inputCls =
  'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-400';
const labelCls = 'block text-sm font-medium text-gray-700';

/** Минимальная длина нового пароля — зеркало политики экшена (MIN_PASSWORD_LENGTH). */
const MIN_PASSWORD_LENGTH = 8;

export function ChangePasswordForm() {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  // Ошибка подтверждения — только клиентская (поля confirm на сервере нет).
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setConfirmError(null);

    // Клиентская проверка совпадения нового пароля и подтверждения.
    if (newPassword !== confirmPassword) {
      setConfirmError('Пароли не совпадают');
      return;
    }

    setPending(true);
    let result: ChangePasswordResult;
    try {
      result = await changePassword({ oldPassword, newPassword });
    } finally {
      setPending(false);
    }

    if (result.ok) {
      // Сессии погашены экшеном — текущая станет невалидной при следующем запросе.
      setDone(true);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      return;
    }

    setError(result.message);
    setFieldErrors(result.fieldErrors ?? {});
  }

  function fe(field: string): string | null {
    return fieldErrors[field]?.[0] ?? null;
  }

  if (done) {
    return (
      <div
        role="status"
        className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-800"
      >
        <p className="font-medium">Пароль изменён.</p>
        <p className="mt-1">
          В целях безопасности все ваши сессии завершены. Войдите заново с новым
          паролем.
        </p>
        <a
          href="/admin/login"
          className="mt-3 inline-flex items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Войти заново
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md">
      {error ? (
        <div
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        <div>
          <label htmlFor="cp-old" className={labelCls}>
            Текущий пароль
          </label>
          <input
            id="cp-old"
            name="oldPassword"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            className={inputCls}
            required
          />
          {fe('oldPassword') ? (
            <p className="mt-1 text-xs text-red-600">{fe('oldPassword')}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="cp-new" className={labelCls}>
            Новый пароль
          </label>
          <input
            id="cp-new"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={`не короче ${MIN_PASSWORD_LENGTH} символов`}
            className={inputCls}
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
          {fe('newPassword') ? (
            <p className="mt-1 text-xs text-red-600">{fe('newPassword')}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="cp-confirm" className={labelCls}>
            Подтверждение нового пароля
          </label>
          <input
            id="cp-confirm"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={inputCls}
            minLength={MIN_PASSWORD_LENGTH}
            required
            aria-invalid={confirmError ? true : undefined}
          />
          {confirmError ? (
            <p className="mt-1 text-xs text-red-600">{confirmError}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Сохранение…' : 'Сменить пароль'}
        </button>
      </div>
    </form>
  );
}
