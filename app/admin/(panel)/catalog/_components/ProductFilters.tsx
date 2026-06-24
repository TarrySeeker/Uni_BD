'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import type { Brand, CategoryTreeNode } from '@/lib/catalog/types';
import { PRODUCT_STATUSES, type ProductStatus } from '@/lib/catalog/types';

/**
 * Панель фильтров списка товаров (docs/05 §5.2). Состояние фильтров живёт в URL
 * (shareable): поиск, статус, бренд, категория, флаги. Сабмит формирует
 * querystring и навигирует — серверная страница перечитывает listProducts.
 */

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Черновик',
  active: 'Активен',
  archived: 'В архиве',
};

/** Плоский список «отступ + имя» для <select> категорий из дерева. */
function flattenCategories(
  nodes: CategoryTreeNode[],
  depth = 0,
): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const node of nodes) {
    out.push({ id: node.id, label: `${'  '.repeat(depth)}${node.name}` });
    out.push(...flattenCategories(node.children, depth + 1));
  }
  return out;
}

export function ProductFilters({
  brands,
  categoryTree,
}: {
  brands: Brand[];
  categoryTree: CategoryTreeNode[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const [search, setSearch] = useState(params.get('search') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [brandId, setBrandId] = useState(params.get('brandId') ?? '');
  const [categoryId, setCategoryId] = useState(params.get('categoryId') ?? '');
  const [isFeatured, setIsFeatured] = useState(params.get('isFeatured') === '1');
  const [isNew, setIsNew] = useState(params.get('isNew') === '1');
  const [onSale, setOnSale] = useState(params.get('onSale') === '1');

  const categories = flattenCategories(categoryTree);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (search.trim()) next.set('search', search.trim());
    if (status) next.set('status', status);
    if (brandId) next.set('brandId', brandId);
    if (categoryId) next.set('categoryId', categoryId);
    if (isFeatured) next.set('isFeatured', '1');
    if (isNew) next.set('isNew', '1');
    if (onSale) next.set('onSale', '1');
    // Сброс на первую страницу при изменении фильтров.
    router.push(`/admin/catalog${next.toString() ? `?${next.toString()}` : ''}`);
  }

  function reset() {
    setSearch('');
    setStatus('');
    setBrandId('');
    setCategoryId('');
    setIsFeatured(false);
    setIsNew(false);
    setOnSale(false);
    router.push('/admin/catalog');
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-gray-200 bg-gray-50 p-4"
      aria-label="Фильтры товаров"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="f-search" className="block text-xs font-medium text-gray-600">
            Поиск (название / артикул)
          </label>
          <input
            id="f-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Например: халат или SKU-123"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="f-status" className="block text-xs font-medium text-gray-600">
            Статус
          </label>
          <select
            id="f-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Любой</option>
            {PRODUCT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-brand" className="block text-xs font-medium text-gray-600">
            Бренд
          </label>
          <select
            id="f-brand"
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Любой</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-category" className="block text-xs font-medium text-gray-600">
            Категория
          </label>
          <select
            id="f-category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Любая</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="mt-3 flex flex-wrap items-center gap-4">
        <legend className="sr-only">Подборки</legend>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isFeatured}
            onChange={(e) => setIsFeatured(e.target.checked)}
          />
          Хиты
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isNew}
            onChange={(e) => setIsNew(e.target.checked)}
          />
          Новинки
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={onSale}
            onChange={(e) => setOnSale(e.target.checked)}
          />
          Со скидкой
        </label>

        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Сбросить
          </button>
          <button
            type="submit"
            className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            Применить
          </button>
        </div>
      </fieldset>
    </form>
  );
}
