'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { AttributeValue } from '@/lib/catalog/types';

import { addAttributeValueAction, deleteAttributeValueAction } from './form-actions';
import { buildAttributeValuePayload } from './payload';
import { errorMessage, fieldError } from '../../_components/action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Словарь значений характеристики (attribute_values) — для типа select.
 * Добавление значения через addAttributeValue (catalog.write на сервере).
 * Slug опционален: пустой — сгенерируется сервером. Значения отсортированы
 * по sort, value (как в listAttributeValues).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function AttributeValues({
  attributeId,
  values,
  editable,
}: {
  attributeId: string;
  values: AttributeValue[];
  /** false — характеристика не типа select: словарь значений не используется. */
  editable: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  const [value, setValue] = useState('');
  const [slug, setSlug] = useState('');
  const [sort, setSort] = useState('0');

  async function add() {
    setPending(true);
    setError(null);
    const sortNum = Number.parseInt(sort, 10);
    const result = await addAttributeValueAction(
      buildAttributeValuePayload(attributeId, {
        value,
        slug,
        sort: Number.isFinite(sortNum) ? sortNum : undefined,
      }),
    );
    setPending(false);
    if (result.ok) {
      setValue('');
      setSlug('');
      setSort('0');
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function remove(v: AttributeValue) {
    if (!window.confirm(`Удалить значение «${v.value}» из словаря?`)) return;
    setError(null);
    const result = await deleteAttributeValueAction({ id: v.id });
    if (result.ok) router.refresh();
    else setError(result);
  }

  function fe(f: string) {
    return fieldError(error, f);
  }

  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <h2 className="text-sm font-semibold text-gray-800">Значения словаря</h2>
      {!editable ? (
        <p className="mt-2 text-sm text-gray-500">
          Словарь значений используется только для типа «Список значений (select)».
          Для текущего типа значение вводится у конкретного товара.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-gray-500">
            Эти значения выбираются у товара для данной характеристики.
          </p>

          {error ? (
            <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {errorMessage(error)}
            </div>
          ) : null}

          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-gray-500">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Значение</th>
                  <th scope="col" className="px-4 py-2 font-medium">ЧПУ (slug)</th>
                  <th scope="col" className="px-4 py-2 font-medium">Порядок</th>
                  <th scope="col" className="px-4 py-2 font-medium">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {values.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                      Значений пока нет.
                    </td>
                  </tr>
                ) : (
                  values.map((v) => (
                    <tr key={v.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-medium text-gray-800">{v.value}</td>
                      <td className="px-4 py-2 text-gray-600">
                        {v.slug ? <code className="text-xs">{v.slug}</code> : <span className="text-gray-300" aria-hidden="true">—</span>}
                      </td>
                      <td className="px-4 py-2 text-gray-600">{v.sort}</td>
                      <td className="px-4 py-2">
                        <button type="button" onClick={() => void remove(v)}
                          className="text-xs text-red-600 hover:underline">
                          Удалить
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <div>
              <label htmlFor="av-value" className="block text-xs font-medium text-gray-600">Новое значение*</label>
              <input id="av-value" value={value} onChange={(e) => setValue(e.target.value)}
                placeholder="например: Красный"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              {fe('value') ? <p className="mt-1 text-xs text-red-600">{fe('value')}</p> : null}
            </div>
            <div>
              <label htmlFor="av-slug" className="block text-xs font-medium text-gray-600">ЧПУ (slug)</label>
              <input id="av-slug" value={slug} onChange={(e) => setSlug(e.target.value)}
                placeholder="авто из значения"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              {fe('slug') ? <p className="mt-1 text-xs text-red-600">{fe('slug')}</p> : null}
            </div>
            <div>
              <label htmlFor="av-sort" className="block text-xs font-medium text-gray-600">Порядок</label>
              <input id="av-sort" type="number" min={0} value={sort} onChange={(e) => setSort(e.target.value)}
                className="mt-1 w-24 rounded border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <button type="button" onClick={add} disabled={pending}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
              {pending ? 'Добавление…' : 'Добавить'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
