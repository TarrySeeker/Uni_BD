/**
 * Универсальная CMS-страница carre (/<slug>) — статические страницы каталога
 * (about/delivery/payment/policy/offer/contacts/corporate и любые новые),
 * управляемые из админки Admik. Данные — Storefront API (getPage).
 *
 * Catch-all верхнего уровня: Next.js отдаёт приоритет статическим сегментам
 * (/cart, /catalog, /product), поэтому этот `[slug]` их НЕ перехватывает —
 * матчит только одиночные сегменты без своего роута. Нет страницы → notFound().
 *
 * Chrome — общий layout (page-head/page-menu/footer); здесь только контент:
 * хлебные крошки + .page-title>h1 + секции (PageSections). i18n: локаль по
 * умолчанию 'ru' (полноценная локализация витрины — отдельная веха).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPage, getSettings } from '@/lib/api';
import Breadcrumbs, { type Crumb } from '../components/Breadcrumbs';
import PageSections from '../components/cms/PageSections';

export const dynamic = 'force-dynamic';

/** Локаль по умолчанию (веха i18n витрины — позже). Проброс в getPage → API. */
const DEFAULT_LOCALE = 'ru';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPage(slug, DEFAULT_LOCALE);
  if (!page) return { title: 'Страница не найдена — carre' };

  const { meta } = page;
  return {
    title: meta.title ?? `${page.title} — carre`,
    description: meta.description ?? undefined,
    alternates: meta.canonical ? { canonical: meta.canonical } : undefined,
    robots: meta.noindex ? { index: false, follow: false } : undefined,
    openGraph: {
      title: meta.ogTitle ?? meta.title ?? page.title,
      description: meta.ogDescription ?? meta.description ?? undefined,
      images: meta.ogImageUrl ? [{ url: meta.ogImageUrl }] : undefined,
    },
  };
}

export default async function CmsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [page, settings] = await Promise.all([
    getPage(slug, DEFAULT_LOCALE),
    getSettings(),
  ]);
  if (!page) notFound();

  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySymbol = settings?.currency.symbol ?? null;

  const crumbs: Crumb[] = [{ label: page.title }];

  return (
    <div className="sf-cms-page">
      <Breadcrumbs items={crumbs} />

      <div className="page-title">
        <h1>{page.title}</h1>
      </div>

      <PageSections
        sections={page.sections}
        currencyCode={currencyCode}
        currencySymbol={currencySymbol}
      />
    </div>
  );
}
