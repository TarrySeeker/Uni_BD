/**
 * Страница категории carre (/catalog/<slug> и вложенные, с локалью /en//fr/) —
 * сетка товаров категории с сайдбаром и пагинацией.
 *
 * Catch-all роут физически принимает ЛЮБОЙ префикс, поэтому путь валидируется
 * целиком, а не по последнему сегменту: у категории ровно один валидный URL —
 * канонический путь из цепочки предков (`resolveCategoryRoute`/`categoryHref`). Без
 * этого одна категория отдавала 200 по неограниченному числу URL, канонизируя каждый
 * сам на себя (дубли контента в индексе). Мусорный путь → постоянный редирект на
 * канон (с сохранением локали и query), неизвестный slug → 404.
 */

import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getCategories, getSettings } from '@/lib/api';
import {
  rootCategories,
  findCategory,
  resolveCategoryRoute,
  categoryRouteLocation,
} from '@/lib/tree';
import { toLocale, alternatesFor, enabledLocalesFrom } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import { ownTitle } from '@/lib/seo';
import CatalogView from '../CatalogView';

export const dynamic = 'force-dynamic';

/** Query-параметры страницы категории (переживают канонизацию URL). */
type CatalogSearchParams = Record<string, string | string[] | undefined>;

function parsePage(v: string | string[] | undefined): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function firstParam(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw || undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; slug: string[] }>;
}): Promise<Metadata> {
  const { lang, slug } = await params;
  const locale = toLocale(lang);
  const dict = getDictionary(locale);
  const [categories, settings] = await Promise.all([
    getCategories(locale),
    getSettings(locale),
  ]);
  const roots = rootCategories(categories);
  const route = resolveCategoryRoute(roots, slug);
  if (route.status === 'not-found') return { title: dict.catalog.title };
  const cat = findCategory(roots, route.slug);
  const enabledLocales = enabledLocalesFrom(settings?.i18n?.locales);
  // canonical — ВСЕГДА канонический путь категории, а не сырой путь запроса.
  return {
    // Имя категории строкой (шаблон из настроек применит Next), но пустым <title>
    // не бывает: безымянная категория уступает место заголовку раздела.
    title: ownTitle(cat?.name, dict.catalog.title),
    alternates: alternatesFor(route.canonicalPath, locale, enabledLocales),
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string; slug: string[] }>;
  searchParams: Promise<CatalogSearchParams>;
}) {
  const [{ lang, slug }, sp] = await Promise.all([params, searchParams]);
  const locale = toLocale(lang);
  const categories = await getCategories(locale);
  const route = resolveCategoryRoute(rootCategories(categories), slug);

  if (route.status === 'not-found') notFound();

  // Постоянный переезд: 308 (permanentRedirect) — permanent-аналог 301, но с
  // гарантией сохранения метода; поисковики трактуют его как 301 и переносят вес на
  // канонический URL. Временный redirect() (307) индекс бы не почистил.
  if (route.status === 'redirect') {
    permanentRedirect(categoryRouteLocation(route.canonicalPath, locale, sp));
  }

  return (
    <CatalogView
      activeSlug={route.slug}
      page={parsePage(sp.page)}
      sort={firstParam(sp.sort)}
      locale={locale}
    />
  );
}
