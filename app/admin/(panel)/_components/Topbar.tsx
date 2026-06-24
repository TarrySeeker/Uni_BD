import { logout } from '@/lib/auth/actions';
import { ShopLogo } from './ShopLogo';

/**
 * Верхняя панель: брендинг магазина (из .env, без хардкодов) + текущий
 * пользователь + кнопка «Выйти» (Server Action logout через <form action>).
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
        <span className="text-sm text-gray-600">{userEmail}</span>
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
