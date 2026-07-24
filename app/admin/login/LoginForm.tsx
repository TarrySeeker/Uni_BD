'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { login, type LoginResult } from '@/lib/auth/actions';

/**
 * Клиентская форма логина. Использует useActionState поверх Server Action
 * `login`: при ошибке action возвращает LoginResult с единым сообщением
 * (§4.4); при успехе action редиректит на /admin (форма не получает ответа).
 *
 * a11y: <form>, <label> у каждого инпута, сообщение об ошибке в role="alert".
 */

/** Адаптер: useActionState передаёт (prevState, formData). */
async function loginAction(
  _prev: LoginResult | null,
  formData: FormData,
): Promise<LoginResult | null> {
  return login(formData);
}

export function LoginForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<
    LoginResult | null,
    FormData
  >(loginAction, null);

  const errorMessage = state && !state.ok ? state.message : null;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {errorMessage ? (
        <p
          role="alert"
          data-reason="bad-credentials"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium text-gray-700">
          {t('login.emailLabel')}
        </label>
        <input
          id="email"
          name="email"
          type="text"
          autoComplete="username"
          placeholder={t('login.emailPlaceholder')}
          required
          data-testid="login-email"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium text-gray-700">
          {t('login.passwordLabel')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          data-testid="login-password"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        data-testid="login-submit"
        className="mt-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
      >
        {pending ? t('login.submitting') : t('login.submit')}
      </button>
    </form>
  );
}
