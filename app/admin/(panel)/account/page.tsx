import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth/session';

import { PageHeader } from '../_components/PageHeader';
import { ChangePasswordForm } from './_components/ChangePasswordForm';

/**
 * Раздел «Профиль» текущего пользователя (/admin/account).
 *
 * Назначение: дать ЛЮБОМУ залогиненному пользователю достижимый из интерфейса
 * способ сменить СВОЙ пароль. Раньше серверный экшен changePassword существовал,
 * но не вызывался ни из одной страницы/кнопки (тупик владельца).
 *
 * Доступ: без отдельного права — это собственный профиль. Гард — только наличие
 * сессии (requireUser редиректит на /admin/login, если её нет). Симметрично
 * остальным страницам панели, но без проверки permission: смена СВОЕГО пароля
 * никакого права не требует и требовать не должна.
 *
 * force-dynamic: читает cookie сессии (requireUser) — нельзя пререндерить статически.
 */
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requireUser();
  const t = await getTranslations();

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={t('account.page.title')}
        subtitle={t('account.page.subtitle')}
        breadcrumbs={[{ label: t('account.page.title') }]}
      />

      <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[160px_1fr]">
          <dt className="font-medium text-gray-500">{t('account.page.loginLabel')}</dt>
          <dd className="text-gray-900">{user.email}</dd>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">{t('account.page.changePasswordHeading')}</h2>
        <p className="mb-4 text-sm text-gray-600">
          {t('account.page.changePasswordHint')}
        </p>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
