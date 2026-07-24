import { getTranslations } from 'next-intl/server';

import { permissionTitle } from '@/lib/auth/permissions';

/**
 * Простой блок «403 — доступ запрещён» для страниц под правом.
 * Сервер уже принял решение (нет права) — показываем понятное сообщение,
 * не раскрывая внутренних деталей. Код права (напр. `users.read`) переводится
 * в человеко-понятное название (permissionTitle); нестандартные строки
 * (напр. «catalog (модуль выключен)») показываются как есть.
 */
export async function Forbidden({ permission }: { permission: string }) {
  const t = await getTranslations();
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-6">
      <h1 className="text-xl font-semibold text-red-800">
        {t('errors.forbidden.title')}
      </h1>
      <p className="mt-2 text-sm text-red-700">
        {t('errors.forbidden.message', { permission: permissionTitle(permission, t) })}
      </p>
    </div>
  );
}
