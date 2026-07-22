/**
 * Публичная страница дизайнера carre (/designers/<slug>, /en/…, /fr/…) — минимальный
 * порт персональной страницы. Данные — Storefront API `getDesigner` (FullDesignerDto:
 * имя, страна, био, фото, соцсети, видео, workCount, SEO-мета), локализованные.
 *
 * Сетка «работ» дизайнера (M4.1): товары грузятся из Storefront API
 * `getProducts({ designer: slug })`. Пусто → аккуратный `.sf-empty`; есть товары →
 * грид ProductCard.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ProductListItemDto } from '@/lib/types';
import { getDesigner, getProducts, getSettings } from '@/lib/api';
import { toLocale, alternatesFor } from '@/lib/i18n';
import { metaTitle } from '@/lib/seo';
import { getDictionary, fillTemplate } from '@/lib/dictionaries';
import Breadcrumbs, { type Crumb } from '../../components/Breadcrumbs';
import ProductCard from '../../components/ProductCard';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}): Promise<Metadata> {
  const { lang, slug } = await params;
  const locale = toLocale(lang);
  const designer = await getDesigner(slug, locale);
  if (!designer) return { title: getDictionary(locale).notFound.designerMetaTitle };
  return {
    // meta.title от Storefront API — уже с применённым titleTemplate (buildSeoMeta),
    // поэтому absolute. Сырые seoTitle/name — фолбэк, им шаблон Next ещё нужен.
    title: metaTitle(designer.meta.title, designer.seoTitle ?? designer.name),
    description:
      designer.meta.description ?? designer.seoDescription ?? undefined,
    alternates: alternatesFor(`/designers/${slug}`, locale),
    robots: designer.meta.noindex ? { index: false, follow: false } : undefined,
  };
}

export default async function DesignerPage({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) {
  const { lang, slug } = await params;
  const locale = toLocale(lang);
  const dict = getDictionary(locale);
  const [designer, settings, worksRes] = await Promise.all([
    getDesigner(slug, locale),
    getSettings(locale),
    getProducts({ designer: slug, limit: 48 }, locale),
  ]);
  if (!designer) notFound();

  const image = designer.pageImageUrl ?? designer.imageUrl ?? null;
  // Анти-XSS (defense-in-depth к https-гварду схемы): в src iframe / href пускаем
  // ТОЛЬКО https-URL — отсекаем возможные javascript:/data: из любых данных.
  const isHttps = (u: unknown): u is string =>
    typeof u === 'string' && /^https:\/\//i.test(u);
  const videoUrl = isHttps(designer.videoUrl) ? designer.videoUrl : null;
  const socials = Object.entries(designer.socials ?? {}).filter(([, url]) =>
    isHttps(url),
  );

  const crumbs: Crumb[] = [
    { label: dict.common.catalog, href: '/catalog' },
    { label: designer.name },
  ];

  // Работы дизайнера — товары, отфильтрованные по его slug (Storefront API).
  const works: ProductListItemDto[] = worksRes.data;

  return (
    <div className="work">
      <Breadcrumbs items={crumbs} locale={locale} homeLabel={dict.common.home} />

      <div className="work__head">
        {image && (
          <div className="work__slider-col">
            <img
              src={image}
              alt={designer.name}
              className="lazy"
              style={{ width: '100%', height: 'auto', objectFit: 'cover' }}
            />
          </div>
        )}

        <div className="work__info">
          <div className="work-head">
            {designer.country && (
              <div className="work-head__category">{designer.country}</div>
            )}
            <h1 className="work-head__title">{designer.name}</h1>
            {designer.workCount > 0 && (
              <div className="work-head__about">
                <div>{fillTemplate(dict.product.worksCount, { n: designer.workCount })}</div>
              </div>
            )}
          </div>

          {designer.description && (
            <div className="sf-product-descr">
              <div className="sf-product-descr__title">{dict.product.aboutDesigner}</div>
              <div className="sf-product-descr__body">{designer.description}</div>
            </div>
          )}

          {socials.length > 0 && (
            <div className="work-head__about">
              {socials.map(([key, url]) => (
                <a key={key} href={url} target="_blank" rel="noopener noreferrer">
                  {key}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {videoUrl && (
        <div className="mainpage--video">
          <div className="embed-container">
            <iframe
              src={videoUrl}
              width="640"
              height="564"
              frameBorder="0"
              allow="autoplay; fullscreen"
              allowFullScreen
            />
          </div>
        </div>
      )}

      <div className="work__other-sticky">
        <div className="work__other-sticky--head">
          <div className="work__other-sticky--head-title">{dict.product.works}</div>
          {works.length > 0 ? (
            <div className="works-catalog-list works-catalog-list--blocks">
              {works.map((p) => (
                <ProductCard key={p.slug} product={p} locale={locale} />
              ))}
            </div>
          ) : (
            <div className="sf-empty">{dict.product.designerNoWorks}</div>
          )}
        </div>
      </div>
    </div>
  );
}
