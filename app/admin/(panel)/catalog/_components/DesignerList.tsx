'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import type { Designer } from '@/lib/designers/types';

import { deleteDesignerAction } from './form-actions';
import { errorMessage } from './action-result';
import { DESIGNER_LIST_PATH, buildDesignerHref } from './designer-list-url';
import type { ActionResult } from '@/lib/server/action';

/**
 * Список дизайнеров с удалением (§9, ADR §4.4). Удаление — deleteDesigner
 * (ON DELETE SET NULL у products.designer_id: товары не удаляются).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Дизайнер для админ-таблицы: доменный Designer + готовый imageUrl (резолвен на сервере). */
export type DesignerListItem = Designer & { imageUrl: string | null };

export function DesignerList({ designers }: { designers: DesignerListItem[] }) {
  const router = useRouter();
  const t = useTranslations();
  // Поиск/порядок списка живут в query. Карточка обязана получить их ссылкой:
  // иначе useSearchParams() в форме пуст и «Отмена» выбрасывает в начало списка.
  const listQuery = useSearchParams().toString();
  const [error, setError] = useState<Fail | null>(null);

  async function remove(designer: Designer) {
    if (!window.confirm(t('catalog.designer.confirmDelete', { name: designer.name }))) {
      return;
    }
    setError(null);
    const result = await deleteDesignerAction({ id: designer.id });
    if (result.ok) router.refresh();
    else setError(result);
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">{t('catalog.list.colPhoto')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('fields.designerName')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('catalog.common.colAddress')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('fields.country')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('common.states.active')}</th>
              <th scope="col" className="px-4 py-2 font-medium text-right">{t('common.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {designers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  {t('catalog.designer.listEmpty')}
                </td>
              </tr>
            ) : (
              designers.map((d) => {
                const cardHref = buildDesignerHref(`${DESIGNER_LIST_PATH}/${d.id}`, listQuery);
                return (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2">
                      {d.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.imageUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <span className="text-gray-300" aria-hidden="true">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Link href={cardHref} className="font-medium text-blue-700 hover:underline">
                        {d.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-gray-600"><code className="text-xs">{d.slug}</code></td>
                    <td className="px-4 py-2 text-gray-600">{d.country || '—'}</td>
                    <td className="px-4 py-2 text-gray-600">{d.isActive ? t('catalog.variants.yes') : t('catalog.variants.no')}</td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={cardHref}
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                        >
                          {t('common.actions.edit')}
                        </Link>
                        <button
                          type="button"
                          onClick={() => remove(d)}
                          className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                        >
                          {t('common.actions.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
