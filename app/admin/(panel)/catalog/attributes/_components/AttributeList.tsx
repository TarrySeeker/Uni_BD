import Link from 'next/link';

import type { Attribute, AttributeType } from '@/lib/catalog/types';

/**
 * Список характеристик справочника (docs/06 §4.5, F3 аудита). Серверный
 * presentational-компонент: данные приходят из listAttributes + счётчики
 * значений словаря. Управление (создание/правка/значения) — на карточке.
 *
 * Удаления характеристики нет: соответствующего Server Action в каталоге не
 * существует (привязки к товарам), поэтому кнопку «Удалить» не показываем,
 * чтобы UI не обещал недостижимое действие.
 */
const TYPE_LABELS: Record<AttributeType, string> = {
  select: 'Список',
  text: 'Текст',
  number: 'Число',
  boolean: 'Да/нет',
};

export type AttributeListItem = Attribute & { valuesCount: number };

export function AttributeList({ attributes }: { attributes: AttributeListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50 text-left text-gray-500">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Название</th>
            <th scope="col" className="px-4 py-2 font-medium">Код</th>
            <th scope="col" className="px-4 py-2 font-medium">Тип</th>
            <th scope="col" className="px-4 py-2 font-medium">Значений</th>
            <th scope="col" className="px-4 py-2 font-medium">Флаги</th>
            <th scope="col" className="px-4 py-2 font-medium text-right">Действия</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {attributes.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                Характеристик пока нет.
              </td>
            </tr>
          ) : (
            attributes.map((a) => (
              <tr key={a.id} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  <Link href={`/admin/catalog/attributes/${a.id}`} className="font-medium text-blue-700 hover:underline">
                    {a.name}
                  </Link>
                  {a.unit ? <span className="ml-1 text-xs text-gray-400">({a.unit})</span> : null}
                </td>
                <td className="px-4 py-2 text-gray-600"><code className="text-xs">{a.code}</code></td>
                <td className="px-4 py-2 text-gray-600">{TYPE_LABELS[a.type]}</td>
                <td className="px-4 py-2 text-gray-600">
                  {a.type === 'select' ? a.valuesCount : <span className="text-gray-300" aria-hidden="true">—</span>}
                </td>
                <td className="px-4 py-2 text-gray-600">
                  <div className="flex flex-wrap gap-1">
                    {a.isVariant ? <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs text-purple-700">вариант</span> : null}
                    {a.isFilterable ? <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">фильтр</span> : null}
                    {a.isRequired ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">обяз.</span> : null}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/admin/catalog/attributes/${a.id}`}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                    >
                      Редактировать
                    </Link>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
