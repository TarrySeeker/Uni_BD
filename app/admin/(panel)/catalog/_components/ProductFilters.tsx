'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import {
  buildProductListQuery,
  buildProductListResetQuery,
} from '@/lib/catalog/list-filters';
import type { CategoryTreeNode } from '@/lib/catalog/types';
import { PRODUCT_STATUSES, type ProductStatus } from '@/lib/catalog/types';
import type { Designer } from '@/lib/designers/types';

/**
 * Панель фильтров списка товаров (docs/05 §5.2). Состояние фильтров живёт в URL
 * (shareable): поиск, статус, дизайнер, категория, флаги. Сабмит формирует
 * querystring и навигирует — серверная страница перечитывает listProducts.
 *
 * Фасет по бренду убран из панели по ТЗ владельца (п.3) в пользу дизайнера;
 * репозиторий brandId по-прежнему поддерживает, старые ссылки ?brandId=… живы.
 * Поэтому querystring собирает buildProductListQuery: параметры без контрола
 * (brandId, sort) переносятся из текущего URL, иначе «Применить» стёр бы их.
 */

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
  designers,
  categoryTree,
}: {
  designers: Designer[];
  categoryTree: CategoryTreeNode[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations();

  const statusLabel: Record<ProductStatus, string> = {
    draft: t('common.states.draft'),
    active: t('common.states.active'),
    archived: t('catalog.list.statusArchived'),
  };

  const [search, setSearch] = useState(params.get('search') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [designerId, setDesignerId] = useState(params.get('designerId') ?? '');
  const [categoryId, setCategoryId] = useState(params.get('categoryId') ?? '');
  const [isFeatured, setIsFeatured] = useState(params.get('isFeatured') === '1');
  const [isNew, setIsNew] = useState(params.get('isNew') === '1');
  const [onSale, setOnSale] = useState(params.get('onSale') === '1');

  const categories = flattenCategories(categoryTree);

  function go(query: string) {
    router.push(`/admin/catalog${query ? `?${query}` : ''}`);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    go(
      buildProductListQuery(params, {
        search,
        status,
        designerId,
        categoryId,
        isFeatured,
        isNew,
        onSale,
      }),
    );
  }

  function reset() {
    setSearch('');
    setStatus('');
    setDesignerId('');
    setCategoryId('');
    setIsFeatured(false);
    setIsNew(false);
    setOnSale(false);
    go(buildProductListResetQuery(params));
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-gray-200 bg-gray-50 p-4"
      aria-label={t('catalog.list.filtersAria')}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="f-search" className="block text-xs font-medium text-gray-600">
            {t('catalog.list.searchLabel')}
          </label>
          <input
            id="f-search"
            type="search"
            data-testid="product-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('catalog.list.searchPlaceholder')}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="f-status" className="block text-xs font-medium text-gray-600">
            {t('catalog.product.fields.status')}
          </label>
          <select
            id="f-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">{t('catalog.list.anyMasculine')}</option>
            {PRODUCT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-designer" className="block text-xs font-medium text-gray-600">
            {t('catalog.product.fields.designer')}
          </label>
          <select
            id="f-designer"
            value={designerId}
            onChange={(e) => setDesignerId(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">{t('catalog.list.anyMasculine')}</option>
            {designers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-category" className="block text-xs font-medium text-gray-600">
            {t('catalog.list.categoryLabel')}
          </label>
          <select
            id="f-category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">{t('catalog.list.anyFeminine')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="mt-3 flex flex-wrap items-center gap-4">
        <legend className="sr-only">{t('catalog.list.collectionsLegend')}</legend>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isFeatured}
            onChange={(e) => setIsFeatured(e.target.checked)}
          />
          {t('catalog.list.featuredFilter')}
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isNew}
            onChange={(e) => setIsNew(e.target.checked)}
          />
          {t('catalog.list.newFilter')}
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={onSale}
            onChange={(e) => setOnSale(e.target.checked)}
          />
          {t('catalog.list.onSaleFilter')}
        </label>

        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            {t('common.actions.reset')}
          </button>
          <button
            type="submit"
            className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            {t('common.actions.apply')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
