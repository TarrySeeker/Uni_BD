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
 *
 * МАКЕТ (эталон carrerusse.com, docs/41 §3): крошки → двухколоночный `.about`,
 * слева вертикальное меню разделов (`.about__left-col`, ~24%), справа контент
 * (`.about__right-col`) с заголовком по левому краю. ⚠️ На проде пункты боковика
 * были ЯКОРЯМИ одной страницы `/about`; у нас каждый раздел — ОТДЕЛЬНАЯ CMS-
 * страница со своим URL/SEO/переводом, поэтому боковик стал навигацией по
 * страницам. Состав пунктов — из данных магазина (флаг show_in_nav у страницы),
 * см. lib/cms-nav; пусто → левой колонки нет и контент занимает всю ширину.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPage, getPages, getSettings } from '@/lib/api';
import { toLocale, alternatesFor, enabledLocalesFrom, absoluteUrlBase } from '@/lib/i18n';
import { metaTitle } from '@/lib/seo';
import { getDictionary } from '@/lib/dictionaries';
import { buildPageNav } from '@/lib/cms-nav';
import { buildBreadcrumbJsonLd } from '@/lib/breadcrumbs';
import Breadcrumbs, { type Crumb } from '../components/Breadcrumbs';
import JsonLd from '../components/JsonLd';
import PageNav from '../components/PageNav';
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
  // Аудит №34: hreflang обязан быть АБСОЛЮТНЫМ URL (относительные поисковики
  // игнорируют). База — публичный адрес магазина из его же настроек, без хардкода.
  const urlBase = absoluteUrlBase(settings);
  return {
    // meta.title/meta.ogTitle от Storefront API — уже с применённым titleTemplate
    // (buildSeoMeta), поэтому absolute: иначе шаблон layout наложится вторым слоем.
    // og:title Next резолвит тем же шаблоном (resolve-opengraph), правило то же.
    title: metaTitle(meta.title, page.title, settings),
    description: meta.description ?? undefined,
    alternates: meta.canonical
      ? { canonical: meta.canonical }
      : alternatesFor(`/${slug}`, locale, enabledLocales, urlBase),
    robots: meta.noindex ? { index: false, follow: false } : undefined,
    openGraph: {
      title: metaTitle(meta.ogTitle ?? meta.title, page.title, settings),
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
  // Три независимых запроса параллельно: сама страница, настройки (валюта/база
  // URL) и список страниц для бокового меню. Список — отдельный вызов, а не
  // поле страницы: он одинаков для всех доп-страниц и не раздувает /pages/[slug].
  const [page, settings, pages] = await Promise.all([
    getPage(slug, locale),
    getSettings(locale),
    getPages(locale),
  ]);
  if (!page) notFound();

  const currencyCode = settings?.currency?.code ?? 'RUB';
  const currencySymbol = settings?.currency?.symbol ?? null;

  const crumbs: Crumb[] = [{ label: page.title }];
  // Микроразметка крошек: абсолютные URL из настроек магазина (тот же источник,
  // что у hreflang). Настройка не заполнена → null и разметки нет (см. lib/breadcrumbs).
  const breadcrumbLd = buildBreadcrumbJsonLd(crumbs, {
    locale,
    homeLabel: dict.common.home,
    base: absoluteUrlBase(settings),
  });

  // Пункты боковика — ИЗ ДАННЫХ магазина (флаг show_in_nav у CMS-страницы),
  // а не из списка в коде: см. lib/cms-nav. Пусто → колонки нет вовсе.
  const nav = buildPageNav(pages, page.slug);

  return (
    <div className="sf-cms-page">
      <Breadcrumbs items={crumbs} locale={locale} homeLabel={dict.common.home} />
      <JsonLd data={breadcrumbLd} />

      {/* Двухколоночный макет эталона (docs/41 §3): слева меню разделов, справа
          контент. Магазин без отмеченных пунктов не получает пустую колонку —
          левая часть просто не рендерится, а правая занимает всю ширину. */}
      <div className="about">
        {nav.length > 0 && (
          <div className="about__left-col">
            <PageNav items={nav} locale={locale} title={dict.cms.sectionsNavTitle} />
          </div>
        )}

        <div className="about__right-col">
          {/* Заголовок — по левому краю правой колонки, как на эталоне
              (`.about__section-title`), а не центрированный `.page-title`. */}
          <h1 className="about__section-title">{page.title}</h1>

          <PageSections
            sections={page.sections}
            currencyCode={currencyCode}
            currencySymbol={currencySymbol}
            locale={locale}
          />
        </div>
      </div>
    </div>
  );
}
