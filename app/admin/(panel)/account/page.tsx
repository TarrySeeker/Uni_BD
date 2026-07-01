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

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Профиль"
        subtitle="Управление учётной записью и смена пароля."
        breadcrumbs={[{ label: 'Профиль' }]}
      />

      <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[160px_1fr]">
          <dt className="font-medium text-gray-500">Логин (email)</dt>
          <dd className="text-gray-900">{user.email}</dd>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">Сменить пароль</h2>
        <p className="mb-4 text-sm text-gray-600">
          Введите текущий пароль и новый. После смены все ваши сессии завершатся —
          потребуется войти заново.
        </p>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
