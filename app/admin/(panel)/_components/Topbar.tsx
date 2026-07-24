import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { logout } from '@/lib/auth/actions';
import { ShopLogo } from './ShopLogo';
import { LocaleSwitcher } from './LocaleSwitcher';

/**
 * Верхняя панель: брендинг магазина (из .env, без хардкодов) + переключатель языка
 * интерфейса + ссылка на профиль текущего пользователя (email → /admin/account, где
 * можно сменить свой пароль) + кнопка «Выйти» (Server Action logout через
 * <form action>).
 *
 * Email сделан ссылкой на профиль (а не отдельным пунктом меню/правом): смена
 * собственного пароля не требует права и привязана к текущему пользователю —
 * как и кнопка «Выйти». Так раздел «Профиль» достижим из любого места админки.
 *
 * Серверный компонент: подписи локализуются через getTranslations(); текущий язык
 * интерфейса читается getLocale() и передаётся в клиентский LocaleSwitcher.
 */
export async function Topbar({
  shopName,
  shopLogoUrl,
  userEmail,
}: {
  shopName: string;
  shopLogoUrl?: string;
  userEmail: string;
}) {
  const t = await getTranslations();
  const locale = await getLocale();

  return (
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
      <div className="flex items-center gap-3">
        {shopLogoUrl ? <ShopLogo src={shopLogoUrl} shopName={shopName} /> : null}
        <span className="text-lg font-semibold text-gray-900">{shopName}</span>
      </div>

      <div className="flex items-center gap-4">
        <LocaleSwitcher current={locale} />
        <Link
          href="/admin/account"
          className="text-sm text-gray-600 hover:text-gray-900 hover:underline"
          title={t('layout.topbar.profileTitle')}
        >
          {userEmail}
        </Link>
        <form action={logout}>
          <button
            type="submit"
            data-testid="admin-logout"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            {t('layout.topbar.logout')}
          </button>
        </form>
      </div>
    </header>
  );
}
