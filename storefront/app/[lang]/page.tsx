/**
 * Главная витрины carre — 1:1-порт `frontend/views/main/index.twig`. Секции в
 * точном визуальном порядке ЖИВОЙ главной carrerusse.com и с его же классами из
 * app.css:
 *   1. Hero-баннер           .mainpage--head_img      ← settings.home.hero
 *   2. Плитки категорий      .dop-links--adaptive     ← settings.home.tiles      (M4)
 *   3. О нас                 .mainpage--about_us      ← settings.home.about
 *   4. Видео                 .mainpage--video         ← settings.home.video      (M4)
 *   5. Новинки               .mainpage--new           ← /products?new=1
 *   6. Витрина дизайнеров    .mainpage--designers     ← settings.home.designers  (M4)
 *   7. Промо-слайдер         .mainpage--slider        ← settings.home.slider     (M5)
 *   8. Корп./сертификаты     .dop-links--vertical     ← settings.home.corpCert   (M5)
 *   9. Lookbook              .lookbook                ← settings.home.looks
 *
 * ⚠️ Ранее `.dop-links--vertical` был захардкоженным плейсхолдером и удалялся; в
 * M5 он восстановлен как УПРАВЛЯЕМЫЙ из настроек блок (settings.home.corpCert) —
 * плитки/ссылки/фото приходят из shop_settings, а не из кода (мультитенант).
 */

import type { Metadata } from 'next';
import { getNewProducts, getSettings } from '@/lib/api';
import { localizedHref, toLocale, LOCALES, localePrefix } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import ProductCard from './components/ProductCard';
import { PromoSlider } from './components/PromoSlider';

// Всегда рендерим по запросу: при `next build` (docker) API app:3000 ещё не
// поднят — статическая генерация не должна ходить в сеть.
export const dynamic = 'force-dynamic';

/**
 * Defense-in-depth для href из настроек (slider/corpCert): рендерим ссылку/onclick
 * ТОЛЬКО если href — относительный путь от «/» ИЛИ https-URL. Схема M5
 * (internalHrefSchema) уже это гарантирует на входе, но повторная проверка на
 * рендере защищает от «протухших» значений в БД и любого обхода валидации
 * (анти-XSS/анти-open-redirect, как designer.href/video.embedUrl в M4).
 */
function isSafeHref(href: string): boolean {
  // `/path` (но НЕ `//host` — protocol-relative open-redirect) ИЛИ https://-URL.
  return (href.startsWith('/') && !href.startsWith('//')) || /^https:\/\//i.test(href);
}

export function generateStaticParams() {
  return LOCALES.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  return { alternates: { canonical: localePrefix(locale) || '/' } };
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const locale = toLocale((await params).lang);
  const dict = getDictionary(locale);
  const [settings, products] = await Promise.all([
    getSettings(locale),
    getNewProducts(12, locale),
  ]);

  const hero = settings?.home.hero;
  const tiles = settings?.home.tiles;
  const about = settings?.home.about;
  const video = settings?.home.video;
  const designers = settings?.home.designers;
  const slider = settings?.home.slider;
  const corpCert = settings?.home.corpCert;
  const looks = settings?.home.looks;

  // Рендерим только безопасные href (defense-in-depth поверх схемной валидации).
  const sliderSlides = (slider?.slides ?? []).filter((s) => isSafeHref(s.href));
  const corpCertTiles = (corpCert?.tiles ?? []).filter((t) => isSafeHref(t.href));

  // Href из настроек магазина оставляем как есть (управляемый контент, может быть
  // внешним/абсолютным); фиксированные внутренние ссылки локализуем через href().
  const href = (path: string) => localizedHref(path, locale);
  const heroHref = hero?.ctaHref ?? href('/catalog');
  const looksCategories = looks?.categories ?? [];
  const lb0 = looksCategories[0];
  const lb1 = looksCategories[1];
  const lb2 = looksCategories[2];

  return (
    <div className="mainpage">
      {/* 1. Hero — головной баннер (.mainpage--head_img) */}
      {hero && (hero.imageUrl || hero.title) && (
        <div className="mainpage--head_img">
          <a href={heroHref}>
            {hero.imageUrl && <img src={hero.imageUrl} alt="" className="lazy" />}
            {hero.title && (
              <div className="mainpage--head_img--name">{hero.title} →</div>
            )}
          </a>
        </div>
      )}

      {/* 2. Плитки категорий (.dop-links--adaptive) — settings.home.tiles */}
      {tiles?.enabled && tiles.items.length > 0 && (
        <div className="dop-links dop-links--adaptive ">
          {tiles.items.map((t) => (
            <div className="dop-links__box" key={t.href}>
              <a href={t.href}>
                <img alt="" className="lazy" src={t.imageUrl} />
                <div className="dop-links__box-name">{t.title} →</div>
              </a>
            </div>
          ))}
        </div>
      )}

      {/* 3. О нас (.mainpage--about_us) */}
      {about?.title && (
        <div className="mainpage--about_us">
          <div className="mainpage--about_us-name">
            <h1>{about.title}</h1>
          </div>
          <div className="mainpage--about_us-info">
            {about.paragraphs.map((p, i) => (
              <div className="mainpage--about_us-info_text" key={i}>
                {p}
              </div>
            ))}
            <a href={href('/about')}>{dict.home.ourStory}</a>
          </div>
        </div>
      )}

      {/* 4. Видео (.mainpage--video) — settings.home.video */}
      {video?.enabled && video.embedUrl && (
        <div className="mainpage--video">
          <div className="embed-container">
            <iframe
              src={video.embedUrl}
              width="640"
              height="564"
              frameBorder="0"
              allow="autoplay; fullscreen"
              allowFullScreen
            />
          </div>
        </div>
      )}

      {/* 5. Новинки (.mainpage--new) — живой каталог, /products?new=1 */}
      {products.length > 0 && (
        <div className="mainpage--new">
          <h1>{dict.home.newProducts}</h1>
          <div className="mainpage--new-groups_view">
            <div className="active">
              <div className="work-sticky">
                {products.map((p) => (
                  <ProductCard key={p.slug} product={p} locale={locale} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 6. Витрина дизайнеров (.mainpage--designers) — settings.home.designers */}
      {designers?.enabled && designers.items.length > 0 && (
        <div className="mainpage--designers">
          <div className="mainpage--designers_head">{designers.title}</div>
          <div className="mainpage--designers_list">
            {designers.items.map((d) => (
              <div className="mainpage--designers_item" key={d.href}>
                <a href={d.href}>{d.name}</a>
                <div className="mainpage--designers_images">
                  <div
                    className="mainpage--designers_avatar"
                    style={{
                      backgroundImage: `url('${d.avatarUrl}')`,
                      top: `${d.avatarTop}%`,
                    }}
                  />
                  <div
                    className="mainpage--designers_work"
                    style={{
                      backgroundImage: `url('${d.workUrl}')`,
                      top: `${d.workTop}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 7. Промо-слайдер (.mainpage--slider) — settings.home.slider */}
      {slider?.enabled && sliderSlides.length > 0 && (
        <PromoSlider slides={sliderSlides} />
      )}

      {/* 8. Корпоративным / сертификаты (.dop-links--vertical) — settings.home.corpCert */}
      {corpCert?.enabled && corpCertTiles.length > 0 && (
        <div className="dop-links dop-links--vertical ">
          {corpCertTiles.map((t, i) => (
            <div className="dop-links__box" key={`${t.href}-${i}`}>
              <a href={t.href}>
                <img src={t.imageUrl} alt="" className="lazy" />
                <div className="dop-links__box-name">{t.title} →</div>
              </a>
            </div>
          ))}
        </div>
      )}

      {/* 9. Lookbook (.lookbook) — settings.home.looks */}
      {looks?.enabled && looksCategories.length > 0 && (
        <div className="lookbook">
          <h2 className="lookbook__title">{looks.title}</h2>
          <div className="lookbook__rows">
            {lb0 && (
              <div className="lookbook__row lookbook__row--first">
                <div className="lookbook__anons">
                  <p>{lb0.text}</p>
                </div>
                <div className="lookbook__item lookbook__item--first">
                  {lb0.imageUrl && (
                    <img src={lb0.imageUrl} alt="" className="lazy" />
                  )}
                  <p>{lb0.title}</p>
                </div>
              </div>
            )}
            {(lb1 || lb2) && (
              <div className="lookbook__row lookbook__row--second">
                {lb1 && (
                  <div className="lookbook__item lookbook__item--second">
                    {lb1.imageUrl && (
                      <img src={lb1.imageUrl} alt="" className="lazy" />
                    )}
                    <p>{lb1.title}</p>
                  </div>
                )}
                {lb2 && (
                  <div className="lookbook__item lookbook__item--third">
                    {lb2.imageUrl && (
                      <img src={lb2.imageUrl} alt="" className="lazy" />
                    )}
                    <p>{lb2.title}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
