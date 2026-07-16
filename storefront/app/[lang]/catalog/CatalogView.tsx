/**
 * Общий вид каталога carre (порт frontend/views/catalog/list.twig) — используется
 * и индексом /catalog (без slug → все товары), и страницей категории
 * /catalog/[...slug]. Слева сайдбар категорий, справа сетка товаров с пагинацией.
 * Данные — Storefront API (getProducts с фильтром category, пагинация limit/offset).
 */

import { notFound } from 'next/navigation';
import { getCategories, getProducts, getSettings } from '@/lib/api';
import { rootCategories, findCategoryPath } from '@/lib/tree';
import type { CategoryDto } from '@/lib/types';
import ProductCard from '../components/ProductCard';
import CategoryCard from '../components/CategoryCard';
import Breadcrumbs, { type Crumb } from '../components/Breadcrumbs';
import Pagination from '../components/Pagination';
import CatalogSidebar from './CatalogSidebar';

const PAGE_SIZE = 24;

interface Props {
  /** slug активной категории; undefined → индекс каталога (все товары). */
  activeSlug?: string;
  /** Текущая страница (1-based). */
  page: number;
  /** Сортировка каталога (carre: asc/desc); пробрасывается в API и подсветку. */
  sort?: string;
}

/** URL текущей категории/страницы с заданной сортировкой (carre setFilterQuery). */
function sortHref(basePath: string, page: number, sort: string): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  params.set('sort', sort);
  return `${basePath}?${params.toString()}`;
}

export default async function CatalogView({ activeSlug, page, sort }: Props) {
  const currentPage = Math.max(1, Number.isFinite(page) ? page : 1);
  const [categories, settings] = await Promise.all([getCategories(), getSettings()]);
  const roots = rootCategories(categories);

  const path = activeSlug ? findCategoryPath(roots, activeSlug) : [];
  const active: CategoryDto | null = path.length > 0 ? path[path.length - 1] : null;
  if (activeSlug && !active) notFound();

  // Товары выбранной категории (или все) с пагинацией.
  const res = await getProducts({
    category: activeSlug || undefined,
    sort: sort || undefined,
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE,
  });
  const products = res.data;
  const total = res.pagination.total || products.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySym = settings?.currency.symbol ?? null;

  // Лендинг родительской категории: показываем её подкатегории карточками.
  const subCategories: CategoryDto[] = active ? active.children : [];
  const isParentLanding = subCategories.length > 0;
  // На лендинге-родителе без прямых товаров сетку товаров прячем (только карточки).
  const showProducts = !isParentLanding || products.length > 0;

  const crumbs: Crumb[] = [{ label: 'Каталог', href: '/catalog' }];
  for (const node of path) {
    if (node.slug === 'catalog') continue; // корень каталога == сам /catalog
    crumbs.push({ label: node.name, href: `/catalog/${node.slug}` });
  }

  const title = active?.name ?? 'Каталог';
  const basePath = active ? `/catalog/${active.slug}` : '/catalog';

  return (
    <>
      <Breadcrumbs items={crumbs} />

      <div className="page-title">
        <h1>{title}</h1>
      </div>

      <div className="works-catalog">
        <CatalogSidebar
          tree={roots}
          activeSlug={activeSlug}
          clearHref="/catalog"
        />

        <div className="works-catalog-list works-catalog-list--works">
          {showProducts && (
            <div className="works-catalog-list--sort">
              <span>Сортировка по:</span>
              <a
                href={sortHref(basePath, currentPage, 'asc')}
                className={sort === 'asc' ? 'active' : undefined}
              >
                возрастанию цены
              </a>
              <a
                href={sortHref(basePath, currentPage, 'desc')}
                className={sort === 'desc' ? 'active' : undefined}
              >
                убыванию цены
              </a>
            </div>
          )}

          <div className="w-100">
            {isParentLanding && (
              <div className="sf-cat-grid sf-subcats">
                {subCategories.map((c) => (
                  <CategoryCard key={c.slug} category={c} />
                ))}
              </div>
            )}

            {showProducts && (
              <>
                <div className="works-catalog-list works-catalog-list--blocks js-pagination-content-block">
                  {products.length > 0 ? (
                    products.map((p) => (
                      <ProductCard
                        key={p.slug}
                        product={p}
                        currencyCode={currencyCode}
                        currencySymbol={currencySym}
                      />
                    ))
                  ) : (
                    <h2>Ничего не найдено</h2>
                  )}
                </div>

                <Pagination
                  page={currentPage}
                  pageCount={pageCount}
                  basePath={basePath}
                  sort={sort || undefined}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
