/**
 * Индекс каталога carre (/catalog, /en/catalog, /fr/catalog) — все товары + сайдбар
 * верхнего уровня. Тонкая обёртка над общим CatalogView. Рендер по запросу (API
 * поднят только в рантайме, не на build — см. lib/api).
 */

import type { Metadata } from 'next';
import { toLocale, alternatesFor } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import CatalogView from './CatalogView';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  const dict = getDictionary(locale);
  return {
    title: dict.catalog.title,
    alternates: alternatesFor('/catalog', locale),
  };
}

function parsePage(v: string | string[] | undefined): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function firstParam(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw || undefined;
}

export default async function CatalogIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ page?: string | string[]; sort?: string | string[] }>;
}) {
  const [{ lang }, sp] = await Promise.all([params, searchParams]);
  return (
    <CatalogView
      page={parsePage(sp.page)}
      sort={firstParam(sp.sort)}
      locale={toLocale(lang)}
    />
  );
}
