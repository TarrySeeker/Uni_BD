import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/session';
import { getEffectiveSettings } from '@/lib/config/settings';

import { LoginForm } from './LoginForm';

/**
 * Страница логина (docs/04 §6.4). ВНЕ admin-layout группы (panel): этот файл —
 * сиблинг группы `(panel)`, поэтому не наследует layout с requireUser(), и
 * остаётся публичным. Без admin-навигации (§6.1).
 *
 * Если пользователь уже авторизован — сразу redirect на /admin.
 *
 * force-dynamic: читает cookie/сессию — не пререндерить статически при build.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect('/admin');
  }

  // Брендинг — из эффективных настроек (env ⊕ БД, fallback env), docs/11 §5.4.5.
  const { branding } = await getEffectiveSettings();
  const shopName = branding.shopName;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- логотип из произвольного внешнего URL (настройки)
            <img
              src={branding.logoUrl}
              alt={`Логотип: ${shopName}`}
              className="h-10 w-auto"
            />
          ) : null}
          <h1 className="text-xl font-semibold text-gray-900">{shopName}</h1>
          <p className="text-sm text-gray-500">Вход в панель управления</p>
        </div>

        <LoginForm />
      </div>
    </main>
  );
}
