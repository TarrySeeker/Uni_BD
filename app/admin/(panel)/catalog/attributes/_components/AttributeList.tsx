import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

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
export type AttributeListItem = Attribute & { valuesCount: number };

export async function AttributeList({ attributes }: { attributes: AttributeListItem[] }) {
  const t = await getTranslations();

  const typeLabels: Record<AttributeType, string> = {
    select: t('catalog.attribute.typeShort.select'),
    text: t('catalog.attribute.types.text'),
    number: t('catalog.attribute.types.number'),
    boolean: t('catalog.attribute.typeShort.boolean'),
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50 text-left text-gray-500">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">{t('fields.name')}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t('catalog.attribute.fields.code')}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t('catalog.attribute.list.colType')}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t('catalog.attribute.list.colValuesCount')}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t('catalog.list.colFlags')}</th>
            <th scope="col" className="px-4 py-2 font-medium text-right">{t('common.table.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {attributes.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                {t('catalog.attribute.list.empty')}
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
                <td className="px-4 py-2 text-gray-600">{typeLabels[a.type]}</td>
                <td className="px-4 py-2 text-gray-600">
                  {a.type === 'select' ? a.valuesCount : <span className="text-gray-300" aria-hidden="true">—</span>}
                </td>
                <td className="px-4 py-2 text-gray-600">
                  <div className="flex flex-wrap gap-1">
                    {a.isVariant ? <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs text-purple-700">{t('catalog.attribute.badges.variant')}</span> : null}
                    {a.isFilterable ? <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">{t('catalog.attribute.badges.filterable')}</span> : null}
                    {a.isRequired ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">{t('catalog.attribute.badges.required')}</span> : null}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/admin/catalog/attributes/${a.id}`}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                    >
                      {t('common.actions.edit')}
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
