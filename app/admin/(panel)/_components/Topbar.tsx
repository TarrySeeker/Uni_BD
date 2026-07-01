import Link from 'next/link';

import { logout } from '@/lib/auth/actions';
import { ShopLogo } from './ShopLogo';

/**
 * Верхняя панель: брендинг магазина (из .env, без хардкодов) + ссылка на профиль
 * текущего пользователя (email → /admin/account, где можно сменить свой пароль) +
 * кнопка «Выйти» (Server Action logout через <form action>).
 *
 * Email сделан ссылкой на профиль (а не отдельным пунктом меню/правом): смена
 * собственного пароля не требует права и привязана к текущему пользователю —
 * как и кнопка «Выйти». Так раздел «Профиль» достижим из любого места админки.
 */
export function Topbar({
  shopName,
  shopLogoUrl,
  userEmail,
}: {
  shopName: string;
  shopLogoUrl?: string;
  userEmail: string;
}) {
  return (
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
      <div className="flex items-center gap-3">
        {shopLogoUrl ? <ShopLogo src={shopLogoUrl} shopName={shopName} /> : null}
        <span className="text-lg font-semibold text-gray-900">{shopName}</span>
      </div>

      <div className="flex items-center gap-4">
        <Link
          href="/admin/account"
          className="text-sm text-gray-600 hover:text-gray-900 hover:underline"
          title="Профиль и смена пароля"
        >
          {userEmail}
        </Link>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Выйти
          </button>
        </form>
      </div>
    </header>
  );
}
