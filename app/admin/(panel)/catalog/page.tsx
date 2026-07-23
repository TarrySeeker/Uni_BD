import Link from 'next/link';

import { getEnv } from '@/lib/config/env';
import { listProducts, getCategoryTree } from '@/lib/catalog/repository';
import {
  PRODUCT_LIST_PAGE_SIZE,
  parseProductListFilter,
} from '@/lib/catalog/list-filters';
import { listDesigners } from '@/lib/designers';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardCatalog } from './_components/guard';
import { ProductFilters } from './_components/ProductFilters';
import { ProductBulkTable } from './_components/ProductBulkTable';

/**
 * Список товаров каталога (docs/05 §5.2, П4.1).
 *
 * Серверная загрузка через listProducts: фильтры/поиск/пагинация — из
 * searchParams (URL = состояние, shareable). Колонки: фото, название, SKU,
 * бренд, цена (со старой ценой и бейджем скидки%), статус, флаги New|Хит,
 * остаток. Доступ — серверный (guardCatalog: модуль + catalog.read).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = PRODUCT_LIST_PAGE_SIZE;

/** Сохраняет текущие фильтры, меняя только page (для ссылок пагинации). */
function pageHref(
  sp: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'page') continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value) next.set(k, value);
  }
  next.set('page', String(page));
  return `/admin/catalog?${next.toString()}`;
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const sp = await searchParams;
  const filter = parseProductListFilter(sp, PAGE_SIZE);
  const currency = getEnv().SHOP_CURRENCY;

  const [{ rows, total }, designers, categoryTree] = await Promise.all([
    listProducts(filter),
    listDesigners(),
    getCategoryTree(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(filter.page, totalPages);

  return (
    <div>
      <PageHeader
        title="Каталог — товары"
        subtitle={`Найдено товаров: ${total}. Цены в ${currency}.`}
        breadcrumbs={[{ label: 'Каталог' }]}
        action={
          <Link
            href="/admin/catalog/products/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Создать товар
          </Link>
        }
      />

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Разделы каталога">
        <Link href="/admin/catalog/categories" className="text-blue-700 hover:underline">
          Категории
        </Link>
        <span className="text-gray-300">·</span>
        <Link href="/admin/catalog/brands" className="text-blue-700 hover:underline">
          Бренды
        </Link>
        <span className="text-gray-300">·</span>
        <Link href="/admin/catalog/designers" className="text-blue-700 hover:underline">
          Дизайнеры
        </Link>
        <span className="text-gray-300">·</span>
        <Link href="/admin/catalog/attributes" className="text-blue-700 hover:underline">
          Характеристики
        </Link>
      </nav>

      <div className="mt-4">
        <ProductFilters designers={designers} categoryTree={categoryTree} />
      </div>

      <div className="mt-6">
        <ProductBulkTable rows={rows} currency={currency} />
      </div>

      {totalPages > 1 ? (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          aria-label="Пагинация"
        >
          <span className="text-gray-500">
            Страница {currentPage} из {totalPages}
          </span>
          <div className="flex gap-2">
            {currentPage > 1 ? (
              <Link
                href={pageHref(sp, currentPage - 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Назад
              </Link>
            ) : null}
            {currentPage < totalPages ? (
              <Link
                href={pageHref(sp, currentPage + 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Вперёд
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
