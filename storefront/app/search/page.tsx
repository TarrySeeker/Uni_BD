/**
 * Поиск по каталогу carre (/search?q=...) — серверный компонент. Читает строку
 * запроса из searchParams (Promise в этой версии Next), дергает Storefront API
 * (getProducts({ search })) и рендерит результаты той же сеткой .works-catalog /
 * .works-catalog-list--blocks, что и каталог. Пустой q → приглашение к поиску;
 * ноль результатов → «Ничего не найдено». Классы works-catalog-* и
 * work-box/work-item сохранены 1:1 (app.css carre). Рендер по запросу (API поднят
 * только в рантайме, не на build — см. lib/api).
 */

import type { Metadata } from 'next';
import { getProducts, getSettings } from '@/lib/api';
import ProductCard from '../components/ProductCard';
import CatalogBodyClass from './CatalogBodyClass';

export const dynamic = 'force-dynamic';

const SEARCH_LIMIT = 48;

/** Первое значение query-параметра, обрезанное по краям (пусто → ''). */
function searchQuery(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? '').trim();
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}): Promise<Metadata> {
  const q = searchQuery((await searchParams).q);
  return { title: q ? `Поиск: «${q}» — carre` : 'Поиск — carre' };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const q = searchQuery((await searchParams).q);

  // Пустой запрос — приглашение к поиску (без обращения к API).
  if (!q) {
    return (
      <>
        <CatalogBodyClass />
        <div className="page-title">
          <h1>Поиск</h1>
        </div>
        <div className="sf-empty">
          Введите запрос в поле поиска, чтобы найти товары.{' '}
          <a href="/catalog">Перейти в каталог →</a>
        </div>
      </>
    );
  }

  const [res, settings] = await Promise.all([
    getProducts({ search: q, limit: SEARCH_LIMIT }),
    getSettings(),
  ]);
  const products = res.data;
  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySym = settings?.currency.symbol ?? null;

  return (
    <>
      <CatalogBodyClass />

      <div className="page-title">
        <h1>Поиск: «{q}»</h1>
      </div>

      <div className="works-catalog sf-search">
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
      </div>
    </>
  );
}
