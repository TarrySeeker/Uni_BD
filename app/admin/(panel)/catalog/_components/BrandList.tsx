'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Brand } from '@/lib/catalog/types';

import { deleteBrandAction } from './form-actions';
import { errorMessage } from './action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Список брендов с удалением (docs/06 §3.3, П4.4). Удаление — deleteBrand
 * (ON DELETE SET NULL у products.brand_id: товары не удаляются).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Бренд для админ-таблицы: доменный Brand + готовый logoUrl, резолвенный на
 * сервере из logoKey (storage.url) — домен URL не хранит (как og:image).
 */
export type BrandListItem = Brand & { logoUrl: string | null };

export function BrandList({ brands }: { brands: BrandListItem[] }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);

  async function remove(brand: Brand) {
    if (!window.confirm(`Удалить бренд «${brand.name}»? Товары не удалятся, у них снимется бренд.`)) {
      return;
    }
    setError(null);
    const result = await deleteBrandAction({ id: brand.id });
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
              <th scope="col" className="px-4 py-2 font-medium">Лого</th>
              <th scope="col" className="px-4 py-2 font-medium">Название</th>
              <th scope="col" className="px-4 py-2 font-medium">Адрес</th>
              <th scope="col" className="px-4 py-2 font-medium">Активен</th>
              <th scope="col" className="px-4 py-2 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {brands.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  Брендов пока нет.
                </td>
              </tr>
            ) : (
              brands.map((b) => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    {b.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
                    ) : (
                      <span className="text-gray-300" aria-hidden="true">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/admin/catalog/brands/${b.id}`} className="font-medium text-blue-700 hover:underline">
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600"><code className="text-xs">{b.slug}</code></td>
                  <td className="px-4 py-2 text-gray-600">{b.isActive ? 'да' : 'нет'}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <Link
                        href={`/admin/catalog/brands/${b.id}`}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                      >
                        Редактировать
                      </Link>
                      <button
                        type="button"
                        onClick={() => remove(b)}
                        className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                      >
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
