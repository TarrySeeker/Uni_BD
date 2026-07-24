/**
 * Универсальная CMS-страница carre (/<slug>, /en/<slug>, /fr/<slug>) — статические
 * страницы каталога (about/delivery/payment/policy/offer/contacts/corporate и
 * любые новые), управляемые из админки Admik. Данные — Storefront API (getPage),
 * локализованные по текущей локали (`?locale=`); контент без перевода API фолбэчит
 * на ru (resolve запрошенный→ru→null).
 *
 * Catch-all внутри сегмента [lang]: Next.js отдаёт приоритет статическим сегментам
 * (/cart, /catalog, /product), поэтому этот `[slug]` их НЕ перехватывает — матчит
 * только одиночные сегменты без своего роута. Нет страницы → notFound().
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPage, getSettings } from '@/lib/api';
import { toLocale, alternatesFor, enabledLocalesFrom } from '@/lib/i18n';
import { metaTitle } from '@/lib/seo';
import { getDictionary } from '@/lib/dictionaries';
import Breadcrumbs, { type Crumb } from '../components/Breadcrumbs';
import PageSections from '../components/cms/PageSections';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}): Promise<Metadata> {
  const { lang, slug } = await params;
  const locale = toLocale(lang);
  const [page, settings] = await Promise.all([
    getPage(slug, locale),
    getSettings(locale),
  ]);
  if (!page) return { title: getDictionary(locale).notFound.pageMetaTitle };

  const { meta } = page;
  const enabledLocales = enabledLocalesFrom(settings?.i18n?.locales);
  return {
    // meta.title/meta.ogTitle от Storefront API — уже с применённым titleTemplate
    // (buildSeoMeta), поэтому absolute: иначе шаблон layout наложится вторым слоем.
    // og:title Next резолвит тем же шаблоном (resolve-opengraph), правило то же.
    title: metaTitle(meta.title, page.title),
    description: meta.description ?? undefined,
    alternates: meta.canonical
      ? { canonical: meta.canonical }
      : alternatesFor(`/${slug}`, locale, enabledLocales),
    robots: meta.noindex ? { index: false, follow: false } : undefined,
    openGraph: {
      title: metaTitle(meta.ogTitle ?? meta.title, page.title),
      description: meta.ogDescription ?? meta.description ?? undefined,
      images: meta.ogImageUrl ? [{ url: meta.ogImageUrl }] : undefined,
    },
  };
}

export default async function CmsPage({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) {
  const { lang, slug } = await params;
  const locale = toLocale(lang);
  const dict = getDictionary(locale);
  const [page, settings] = await Promise.all([
    getPage(slug, locale),
    getSettings(locale),
  ]);
  if (!page) notFound();

  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySymbol = settings?.currency.symbol ?? null;

  const crumbs: Crumb[] = [{ label: page.title }];

  return (
    <div className="sf-cms-page">
      <Breadcrumbs items={crumbs} locale={locale} homeLabel={dict.common.home} />

      <div className="page-title">
        <h1>{page.title}</h1>
      </div>

      <PageSections
        sections={page.sections}
        currencyCode={currencyCode}
        currencySymbol={currencySymbol}
        locale={locale}
      />
    </div>
  );
}
