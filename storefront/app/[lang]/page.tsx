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
 *   9. «Образы»              .sf-looks (вкладки+карусель) ← settings.home.looks
 *
 * ⚠️ Ранее `.dop-links--vertical` был захардкоженным плейсхолдером и удалялся; в
 * M5 он восстановлен как УПРАВЛЯЕМЫЙ из настроек блок (settings.home.corpCert) —
 * плитки/ссылки/фото приходят из shop_settings, а не из кода (мультитенант).
 */

import type { Metadata } from 'next';
import { getNewProducts, getPages, getSettings } from '@/lib/api';
import { buildPageNav } from '@/lib/cms-nav';
import {
  localizedHref,
  toLocale,
  DEFAULT_LOCALE,
  alternatesFor,
  enabledLocalesFrom,
  absoluteUrlBase,
} from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import ProductCard from './components/ProductCard';
import { PromoSlider } from './components/PromoSlider';
import { LooksCarousel } from './components/LooksCarousel';

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

// Пререндерим только дефолтную локаль; en/fr — динамически (force-dynamic выше),
// т.к. набор включённых языков известен лишь в рантайме (настройки магазина).
export function generateStaticParams() {
  return [{ lang: DEFAULT_LOCALE }];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  // 🔴 АУДИТ №34. Прежде здесь стоял ТОЛЬКО canonical (относительным путём), то есть
  // на ГЛАВНОЙ — самой важной для языкового таргетинга странице мультиязычного
  // магазина — hreflang не было вовсе. Теперь главная эмитит тот же набор
  // альтернатив, что и остальные SEO-страницы: по ВКЛЮЧЁННЫМ языкам магазина и
  // АБСОЛЮТНЫМИ URL (база — публичный адрес из настроек, домен не хардкодится).
  const settings = await getSettings(locale);
  const enabledLocales = enabledLocalesFrom(settings?.i18n?.locales);
  return {
    alternates: alternatesFor('/', locale, enabledLocales, absoluteUrlBase(settings)),
  };
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const locale = toLocale((await params).lang);
  const dict = getDictionary(locale);
  const [settings, products, pages] = await Promise.all([
    getSettings(locale),
    getNewProducts(12, locale),
    getPages(locale),
  ]);

  const hero = settings?.home?.hero;
  const tiles = settings?.home?.tiles;
  const about = settings?.home?.about;
  const video = settings?.home?.video;
  const designers = settings?.home?.designers;
  const slider = settings?.home?.slider;
  const corpCert = settings?.home?.corpCert;
  const looks = settings?.home?.looks;

  // Рендерим только безопасные href (defense-in-depth поверх схемной валидации).
  const sliderSlides = (slider?.slides ?? []).filter((s) => isSafeHref(s.href));
  const corpCertTiles = (corpCert?.tiles ?? []).filter((t) => isSafeHref(t.href));
  // Списки внутри секций — тоже через `?? []`: секция может приехать без своего
  // массива (version skew витрины и админки), а падение здесь = 500 главной.
  const tileItems = tiles?.items ?? [];
  const aboutParagraphs = about?.paragraphs ?? [];
  const designerItems = designers?.items ?? [];

  // Href из настроек магазина оставляем как есть (управляемый контент, может быть
  // внешним/абсолютным); фиксированные внутренние ссылки локализуем через href().
  const href = (path: string) => localizedHref(path, locale);
  const heroHref = hero?.ctaHref ?? href('/catalog');
  // Ссылка «Наша история» блока «О нас» ведёт на КОНТЕНТНУЮ страницу магазина, и
  // её адрес — тоже данные: берём ПЕРВЫЙ пункт бокового меню разделов (та самая
  // страница, которую владелец поставил первой в админке). Раньше здесь был
  // зашитый '/about' — у магазина без такого slug ссылка вела в 404, а у магазина
  // с другим составом страниц — не туда. Нет ни одного отмеченного пункта →
  // ссылку не показываем вовсе (лучше её отсутствие, чем битый адрес).
  const aboutHref = buildPageNav(pages, '')[0]?.href ?? null;
  // «Образы» v2: вкладки-категории + карусель карточек «автор + фото». Списки —
  // через `?? []` (секция может приехать без массива при version skew: падение
  // здесь = 500 главной). Категории отдаём как {id,title} — text/imageUrl это
  // наследие v1, вкладке они не нужны.
  const looksCategories = (looks?.categories ?? []).map((c) => ({ id: c.id, title: c.title }));
  const looksItems = looks?.items ?? [];

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
      {tiles?.enabled && tileItems.length > 0 && (
        <div className="dop-links dop-links--adaptive ">
          {tileItems.map((t) => (
            <div className="dop-links__box" key={t.href}>
              <a href={t.href}>
                <img alt="" className="lazy" src={t.imageUrl} />
                <div className="dop-links__box-name">{t.title} →</div>
              </a>
            </div>
          ))}
        </div>
      )}

      {/* 3. О нас (.mainpage--about_us) — макет владельца: СЛЕВА крупная фраза
          магазина в две строки, СПРАВА широкая колонка текста и ссылка «Наша
          история» с подчёркиванием. Колонки 50/50 и подчёркивание ссылки уже
          заданы `/dist/app.css` (.mainpage--about_us*), на мобильном там же
          flex-direction:column — колонки складываются одна под другую.

          ⚠️ РАСХОЖДЕНИЕ С ЭТАЛОНОМ, подтверждённое владельцем: на боевом
          carrerusse.com слева стоял «О нас», а фраза «Carré Russe — искусство…»
          была <h3> в правой колонке (docs/41 §4). Делаем как на скриншоте —
          фраза слева и крупно. Сама фраза — ДАННЫЕ (home.about.title из настроек
          магазина), а не литерал: у следующего магазина она своя. */}
      {about?.title && (
        <div className="mainpage--about_us">
          <div className="mainpage--about_us-name">
            <h1>{about.title}</h1>
          </div>
          <div className="mainpage--about_us-info">
            {aboutParagraphs.map((p, i) => (
              <div className="mainpage--about_us-info_text" key={i}>
                {p}
              </div>
            ))}
            {/* Адрес — из данных (первый раздел бокового меню, см. aboutHref).
                Магазин без контентных страниц ссылку просто не показывает. */}
            {aboutHref && <a href={href(aboutHref)}>{dict.home.ourStory}</a>}
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
      {designers?.enabled && designerItems.length > 0 && (
        <div className="mainpage--designers">
          <div className="mainpage--designers_head">{designers.title}</div>
          <div className="mainpage--designers_list">
            {designerItems.map((d) => (
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

      {/* 9. «Образы» — settings.home.looks: вкладки-категории + карусель карточек.
          Клиентский компонент (вкладки/листание), но карточки в разметке сразу —
          SSR-дружественно для SEO (фото и имена есть в HTML до гидратации). */}
      {looks?.enabled && looksCategories.length > 0 && looksItems.length > 0 && (
        <LooksCarousel
          title={looks.title}
          categories={looksCategories}
          items={looksItems}
          labels={{ next: dict.home.looksNext, tabs: dict.home.looksTabsAria }}
        />
      )}
    </div>
  );
}
