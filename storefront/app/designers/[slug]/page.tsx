/**
 * Публичная страница дизайнера carre (/designers/<slug>) — минимальный порт
 * персональной страницы. Данные — Storefront API `getDesigner` (FullDesignerDto:
 * имя, страна, био, фото, соцсети, видео, workCount, SEO-мета).
 *
 * Сетка «работ» дизайнера (M4.1): товары грузятся из Storefront API
 * `getProducts({ designer: slug })` — фильтр `?designer=<slug>` резолвит slug
 * активного дизайнера → его товары. Пусто (у дизайнера нет работ / сбой сети) →
 * аккуратный `.sf-empty`; есть товары → грид ProductCard.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ProductListItemDto } from '@/lib/types';
import { getDesigner, getProducts, getSettings } from '@/lib/api';
import Breadcrumbs, { type Crumb } from '../../components/Breadcrumbs';
import ProductCard from '../../components/ProductCard';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const designer = await getDesigner(slug);
  if (!designer) return { title: 'Дизайнер не найден — carre' };
  return {
    title: designer.meta.title ?? designer.seoTitle ?? `${designer.name} — carre`,
    description:
      designer.meta.description ?? designer.seoDescription ?? undefined,
    robots: designer.meta.noindex ? { index: false, follow: false } : undefined,
  };
}

export default async function DesignerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [designer, settings, worksRes] = await Promise.all([
    getDesigner(slug),
    getSettings(),
    getProducts({ designer: slug, limit: 48 }),
  ]);
  if (!designer) notFound();

  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySym = settings?.currency.symbol ?? null;

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
    { label: 'Каталог', href: '/catalog' },
    { label: designer.name },
  ];

  // Работы дизайнера — товары, отфильтрованные по его slug (Storefront API).
  // Пусто (нет работ / сбой сети → getProducts деградирует в пустой список) →
  // ниже отрисуется .sf-empty.
  const works: ProductListItemDto[] = worksRes.data;

  return (
    <div className="work">
      <Breadcrumbs items={crumbs} />

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
                <div>Работ: {designer.workCount}</div>
              </div>
            )}
          </div>

          {designer.description && (
            <div className="sf-product-descr">
              <div className="sf-product-descr__title">О дизайнере</div>
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
          <div className="work__other-sticky--head-title">Работы</div>
          {works.length > 0 ? (
            <div className="works-catalog-list works-catalog-list--blocks">
              {works.map((p) => (
                <ProductCard
                  key={p.slug}
                  product={p}
                  currencyCode={currencyCode}
                  currencySymbol={currencySym}
                />
              ))}
            </div>
          ) : (
            <div className="sf-empty">
              У этого дизайнера пока нет опубликованных работ.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
