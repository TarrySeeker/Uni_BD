/**
 * Поиск по каталогу carre (/search?q=..., /en/search, /fr/search) — серверный
 * компонент. Читает строку запроса из searchParams (Promise в этой версии Next),
 * дергает Storefront API (getProducts({ search }, locale)) и рендерит результаты той
 * же сеткой .works-catalog / .works-catalog-list--blocks, что и каталог. Пустой q →
 * приглашение к поиску; ноль результатов → «Ничего не найдено». Рендер по запросу.
 */

import type { Metadata } from 'next';
import { getProducts } from '@/lib/api';
import { localizedHref, toLocale, alternatesFor } from '@/lib/i18n';
import { getDictionary, fillTemplate } from '@/lib/dictionaries';
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
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}): Promise<Metadata> {
  const [{ lang }, sp] = await Promise.all([params, searchParams]);
  const locale = toLocale(lang);
  const dict = getDictionary(locale);
  const q = searchQuery(sp.q);
  return {
    title: q
      ? `${fillTemplate(dict.search.resultsFor, { q })} — carre`
      : `${dict.search.title} — carre`,
    alternates: alternatesFor('/search', locale),
  };
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const [{ lang }, sp] = await Promise.all([params, searchParams]);
  const locale = toLocale(lang);
  const dict = getDictionary(locale);
  const q = searchQuery(sp.q);

  // Пустой запрос — приглашение к поиску (без обращения к API).
  if (!q) {
    return (
      <>
        <CatalogBodyClass />
        <div className="page-title">
          <h1>{dict.search.title}</h1>
        </div>
        <div className="sf-empty">
          {dict.search.prompt}{' '}
          <a href={localizedHref('/catalog', locale)}>{dict.common.goToCatalog}</a>
        </div>
      </>
    );
  }

  const res = await getProducts({ search: q, limit: SEARCH_LIMIT }, locale);
  const products = res.data;

  return (
    <>
      <CatalogBodyClass />

      <div className="page-title">
        <h1>{fillTemplate(dict.search.resultsFor, { q })}</h1>
      </div>

      <div className="works-catalog sf-search">
        <div className="works-catalog-list works-catalog-list--blocks js-pagination-content-block">
          {products.length > 0 ? (
            products.map((p) => (
              <ProductCard key={p.slug} product={p} locale={locale} />
            ))
          ) : (
            <h2>{dict.common.nothingFound}</h2>
          )}
        </div>
      </div>
    </>
  );
}
