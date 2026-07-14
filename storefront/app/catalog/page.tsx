/**
 * Индекс каталога carre (/catalog) — все товары + сайдбар верхнего уровня.
 * Тонкая обёртка над общим CatalogView. Рендер по запросу (API поднят только в
 * рантайме, не на build — см. lib/api).
 */

import CatalogView from './CatalogView';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Каталог — carre',
};

function parsePage(v: string | string[] | undefined): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

export default async function CatalogIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const sp = await searchParams;
  return <CatalogView page={parsePage(sp.page)} />;
}
