'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import type { ProductListRow } from '@/lib/catalog/types';

import { PriceCell } from './PriceCell';
import { StatusBadge, NewBadge, FeaturedBadge } from './Badges';
import {
  bulkSetProductStatusAction,
  duplicateProductAction,
} from './form-actions';
import { errorMessage } from './action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Клиентская таблица товаров с массовым выбором и дублированием (массовые
 * действия, П4.1). Серверная страница готовит данные (listProducts) и передаёт
 * их пропсами — здесь только разметка строк, чекбоксы и тулбар; фильтры,
 * пагинация и набор колонок не меняются.
 *
 * Массовые действия вызывают bulkSetProductStatus, единичное дублирование —
 * duplicateProduct; после успеха — router.refresh()/router.push() (списочные
 * пути инвалидируются в самих Server Actions).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function ProductBulkTable({
  rows,
  currency,
}: {
  rows: ProductListRow[];
  currency: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Fail | null>(null);

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const selectedCount = selected.size;

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(ids) : new Set());
  }

  async function applyStatus(status: 'active' | 'archived') {
    const list = ids.filter((id) => selected.has(id));
    if (list.length === 0) return;
    if (
      status === 'archived' &&
      !window.confirm(`Отправить в архив выбранные товары (${list.length})?`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await bulkSetProductStatusAction({ ids: list, status });
    setBusy(false);
    if (result.ok) {
      setSelected(new Set());
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function duplicate(id: string) {
    setBusy(true);
    setError(null);
    const result = await duplicateProductAction({ id });
    setBusy(false);
    if (result.ok) {
      router.push(`/admin/catalog/products/${result.data.id}`);
    } else {
      setError(result);
    }
  }

  return (
    <div>
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {errorMessage(error)}
        </div>
      ) : null}

      {selectedCount > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm">
          <span className="font-medium text-gray-700">
            Выбрано: {selectedCount}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => applyStatus('active')}
            className="rounded-md border border-green-300 px-3 py-1.5 font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
          >
            Опубликовать
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => applyStatus('archived')}
            className="rounded-md border border-amber-300 px-3 py-1.5 font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
          >
            В архив
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setSelected(new Set())}
            className="text-gray-500 hover:underline disabled:opacity-50"
          >
            Снять выделение
          </button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                <input
                  type="checkbox"
                  aria-label="Выбрать все товары"
                  checked={allSelected}
                  disabled={ids.length === 0}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </th>
              <th scope="col" className="px-4 py-2 font-medium">Фото</th>
              <th scope="col" className="px-4 py-2 font-medium">Название</th>
              <th scope="col" className="px-4 py-2 font-medium">Артикул</th>
              <th scope="col" className="px-4 py-2 font-medium">Бренд</th>
              <th scope="col" className="px-4 py-2 font-medium">Цена</th>
              <th scope="col" className="px-4 py-2 font-medium">Статус</th>
              <th scope="col" className="px-4 py-2 font-medium">Флаги</th>
              <th scope="col" className="px-4 py-2 font-medium">Остаток</th>
              <th scope="col" className="px-4 py-2 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-gray-400">
                  Товары не найдены. Измените фильтры или создайте товар.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={selected.has(row.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}
                >
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Выбрать товар ${row.name}`}
                      checked={selected.has(row.id)}
                      onChange={(e) => toggleOne(row.id, e.target.checked)}
                    />
                  </td>
                  <td className="px-4 py-2">
                    {row.primaryMediaUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={row.primaryMediaUrl}
                        alt=""
                        className="h-10 w-10 rounded object-cover"
                      />
                    ) : (
                      <div
                        className="flex h-10 w-10 items-center justify-center rounded bg-gray-100 text-xs text-gray-400"
                        aria-hidden="true"
                      >
                        —
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/catalog/products/${row.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    <code className="text-xs">{row.sku}</code>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {row.brand?.name ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    <PriceCell
                      price={row.basePrice}
                      compareAt={row.compareAtPrice}
                      discountPct={row.discountPct}
                      currency={currency}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {row.effectiveIsNew ? <NewBadge /> : null}
                      {row.isFeatured ? <FeaturedBadge /> : null}
                      {!row.effectiveIsNew && !row.isFeatured ? (
                        <span className="text-gray-400">—</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{row.totalStock}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <Link
                        href={`/admin/catalog/products/${row.id}`}
                        className="inline-block rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                      >
                        Редактировать
                      </Link>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => duplicate(row.id)}
                        className="inline-block rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                      >
                        Дублировать
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
