import Link from 'next/link';

/**
 * Уведомление «раздел отключён однопользовательским режимом» (B9).
 *
 * Это guard-страница (защита от прямого захода по URL): меню уже прячет пункты
 * «Пользователи»/«Роли», а Server Actions блокируют мутации на сервере — но
 * прямой переход по адресу всё равно резолвится, поэтому страница рендерит понятную
 * заглушку вместо формы. Режим магазина (а не право), поэтому формулировка — про
 * настройку, а не про недостаток прав. Ссылка ведёт в «Настройки → Доступ», где
 * владелец может выключить режим.
 */
export function SingleUserModeNotice({ kind }: { kind: 'users' | 'roles' }) {
  const what = kind === 'users' ? 'пользователями' : 'ролями';
  return (
    <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-6">
      <h1 className="text-xl font-semibold text-amber-900">Однопользовательский режим</h1>
      <p className="mt-2 text-sm text-amber-800">
        Управление {what} отключено: магазин работает в однопользовательском режиме.
        Включить раздел снова можно в{' '}
        <Link href="/admin/settings#access" className="font-medium underline">
          Настройки → Доступ
        </Link>
        .
      </p>
    </div>
  );
}
