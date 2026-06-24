import type { ReactNode } from 'react';

import { requireUser } from '@/lib/auth/session';
import { buildAdminNav } from '@/lib/admin/nav';
import { getEffectiveSettings, getEffectiveModuleSet } from '@/lib/config/settings';

import { Sidebar } from './_components/Sidebar';
import { Topbar } from './_components/Topbar';

/**
 * Серверный layout каркаса админки (docs/04 §6.2).
 *
 * РЕШЕНИЕ «login vs layout»: этот layout живёт в route-group `(panel)` и
 * оборачивает ВСЕ аутентифицированные разделы (/admin, /admin/users, ...).
 * Страница логина (`app/admin/login/page.tsx`) — СИБЛИНГ группы `(panel)`,
 * поэтому НЕ наследует этот layout и не попадает под requireUser(). Так
 * `/admin/login` остаётся публичным, а все прочие /admin/* защищены. Группа
 * `(panel)` не влияет на URL (скобки не добавляют сегмент пути).
 *
 * force-dynamic: layout читает cookie (requireUser) и env — нельзя пререндерить
 * статически на этапе build. Гарантирует, что Next не дёргает БД при сборке.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Полная валидация сессии (БД): нет/невалидна → redirect на /admin/login.
  const user = await requireUser();

  // Эффективный набор модулей (env ⊕ БД-оверрайд) — авторитетный, как у рантайм-
  // гейтов. Меню реагирует на выключение модуля из UI, а не только на ADMIK_MODULES.
  const enabledModules = await getEffectiveModuleSet();

  // Меню = f(включённые модули, права пользователя) — §6.3.
  const nav = buildAdminNav(user, enabledModules);

  // Брендинг — из эффективных настроек (env ⊕ БД), docs/11 §5.4.5.
  const { branding } = await getEffectiveSettings();

  return (
    <div className="flex min-h-screen flex-col bg-white text-gray-900">
      <Topbar
        shopName={branding.shopName}
        shopLogoUrl={branding.logoUrl ?? undefined}
        userEmail={user.email}
      />
      <div className="flex flex-1 flex-col md:flex-row">
        <Sidebar items={nav} />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
