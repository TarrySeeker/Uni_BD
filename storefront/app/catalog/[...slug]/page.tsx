/**
 * Страница категории carre (/catalog/<slug> и вложенные) — сетка товаров категории
 * с сайдбаром и пагинацией. Catch-all: активной считается ПОСЛЕДНИЙ сегмент пути
 * (slug'и категорий уникальны в API); неизвестный slug → 404 (CatalogView).
 */

import type { Metadata } from 'next';
import { getCategories } from '@/lib/api';
import { rootCategories, findCategory } from '@/lib/tree';
import CatalogView from '../CatalogView';

export const dynamic = 'force-dynamic';

function parsePage(v: string | string[] | undefined): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function firstParam(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw || undefined;
}

function lastSlug(slug: string[]): string {
  return slug[slug.length - 1] ?? '';
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const categories = await getCategories();
  const cat = findCategory(rootCategories(categories), lastSlug(slug));
  return { title: cat ? `${cat.name} — carre` : 'Каталог — carre' };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<{ page?: string | string[]; sort?: string | string[] }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  return (
    <CatalogView
      activeSlug={lastSlug(slug)}
      page={parsePage(sp.page)}
      sort={firstParam(sp.sort)}
    />
  );
}
