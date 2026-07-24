import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * Уведомление «раздел отключён однопользовательским режимом» (B9).
 *
 * Это guard-страница (защита от прямого захода по URL): меню уже прячет пункты
 * «Пользователи»/«Роли», а Server Actions блокируют мутации на сервере — но
 * прямой переход по адресу всё равно резолвится, поэтому страница рендерит понятную
 * заглушку вместо формы. Режим магазина (а не право), поэтому формулировка — про
 * настройку, а не про недостаток прав. Текст ведёт в «Настройки → Доступ», где
 * владелец может выключить режим.
 *
 * Серверный компонент: подписи локализуются через getTranslations(); слово-
 * подстановка {what} («пользователями»/«ролями») тоже берётся из каталога, чтобы
 * склонение было правильным на каждом языке.
 */
export async function SingleUserModeNotice({ kind }: { kind: 'users' | 'roles' }) {
  const t = await getTranslations();
  const what =
    kind === 'users'
      ? t('errors.singleUser.manageUsers')
      : t('errors.singleUser.manageRoles');
  return (
    <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-6">
      <h1 className="text-xl font-semibold text-amber-900">
        {t('errors.singleUser.title')}
      </h1>
      <p className="mt-2 text-sm text-amber-800">
        {t.rich('errors.singleUser.message', {
          what,
          link: (chunks) => (
            <Link href="/admin/settings#access" className="font-medium underline">
              {chunks}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}
