import { permissionTitle } from '@/lib/auth/permissions';

/**
 * Простой блок «403 — доступ запрещён» для страниц под правом.
 * Сервер уже принял решение (нет права) — показываем понятное сообщение,
 * не раскрывая внутренних деталей. Код права (напр. `users.read`) переводится
 * в человеко-понятное название (permissionTitle); нестандартные строки
 * (напр. «catalog (модуль выключен)») показываются как есть.
 */
export function Forbidden({ permission }: { permission: string }) {
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-6">
      <h1 className="text-xl font-semibold text-red-800">
        Доступ к разделу закрыт
      </h1>
      <p className="mt-2 text-sm text-red-700">
        Для этого раздела нужно право «{permissionTitle(permission)}».
        Обратитесь к администратору магазина, чтобы его выдали.
      </p>
    </div>
  );
}
