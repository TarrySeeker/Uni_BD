/**
 * Главная витрины carre — 1:1-порт `frontend/views/main/index.twig` (milestone M1,
 * подмножество без Admik-доработок). Секции в точном визуальном порядке carre и с
 * его же классами из app.css:
 *   1. Hero-баннер           .mainpage--head_img      ← settings.home.hero
 *   2. О нас                 .mainpage--about_us      ← settings.home.about
 *   3. Новинки               .mainpage--new           ← /products?new=1
 *   4. Вертикальные промо    .dop-links--vertical     ← статические ссылки
 *   5. Lookbook              .lookbook                ← settings.home.looks
 *
 * ОТЛОЖЕНО (M4, данных в settings пока нет): промо-плитки thread2/3
 * (.dop-links--adaptive), видео (.mainpage--video), промо-слайдер
 * (.mainpage--slider), витрина дизайнеров (.mainpage--designers).
 */

import { getNewProducts, getSettings } from '@/lib/api';
import ProductCard from './components/ProductCard';

// Всегда рендерим по запросу: при `next build` (docker) API app:3000 ещё не
// поднят — статическая генерация не должна ходить в сеть.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [settings, products] = await Promise.all([getSettings(), getNewProducts(12)]);

  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySymbol = settings?.currency.symbol ?? null;

  const hero = settings?.home.hero;
  const about = settings?.home.about;
  const looks = settings?.home.looks;

  const heroHref = hero?.ctaHref ?? '/catalog';
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

      {/* 2. О нас (.mainpage--about_us) */}
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
            <a href="/about">Наша история</a>
          </div>
        </div>
      )}

      {/* 3. Новинки (.mainpage--new) — живой каталог, /products?new=1 */}
      {products.length > 0 && (
        <div className="mainpage--new">
          <h1>Новинки</h1>
          <div className="mainpage--new-groups_view">
            <div className="active">
              <div className="work-sticky">
                {products.map((p) => (
                  <ProductCard
                    key={p.slug}
                    product={p}
                    currencyCode={currencyCode}
                    currencySymbol={currencySymbol}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Вертикальные промо-плитки (.dop-links--vertical) — статические ссылки */}
      <div className="dop-links dop-links--vertical">
        <div className="dop-links__box">
          <a href="/corporate">
            <div className="dop-links__box-name">Корпоративным клиентам →</div>
          </a>
        </div>
        <div className="dop-links__box">
          <a href="/certificates">
            <div className="dop-links__box-name">Подарочные сертификаты →</div>
          </a>
        </div>
      </div>

      {/* 5. Lookbook (.lookbook) — settings.home.looks */}
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
