/**
 * Главная витрины carre: hero + реальные категории (из /categories) + сетка
 * товаров (из /products, featured с fallback на новинки). Данные — Storefront API
 * Admik. Дизайн — классы carre из app.css (.works-catalog / .work-box / .page-title).
 */

import { getCategories, getHomeProducts, getSettings } from '@/lib/api';
import { browseGroups } from '@/lib/tree';
import ProductCard from './components/ProductCard';
import CategoryCard from './components/CategoryCard';

// Всегда рендерим по запросу: при `next build` (docker) API app:3000 ещё не
// поднят — статическая генерация не должна ходить в сеть.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [settings, categories, products] = await Promise.all([
    getSettings(),
    getCategories(),
    getHomeProducts(12),
  ]);

  const cats = browseGroups(categories);
  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySymbol = settings?.currency.symbol ?? null;

  const heroTitle = settings?.home.hero.title ?? settings?.branding.shopName ?? 'carre';
  const heroSubtitle =
    settings?.home.hero.subtitle ??
    settings?.home.about.title ??
    'Шёлковые платки, твилли и аксессуары';
  const ctaLabel = settings?.home.hero.ctaLabel ?? 'Смотреть коллекцию';
  const ctaHref = settings?.home.hero.ctaHref ?? '/catalog';

  return (
    <div className="mainpage sf-home">
      {/* Hero */}
      <section className="sf-hero">
        <h1 className="sf-hero__title">{heroTitle}</h1>
        <p className="sf-hero__subtitle">{heroSubtitle}</p>
        <a className="sf-hero__cta" href={ctaHref}>
          {ctaLabel} →
        </a>
      </section>

      {/* Категории */}
      {cats.length > 0 && (
        <section className="sf-section">
          <div className="page-title">
            <h1>Категории</h1>
          </div>
          <div className="sf-cat-grid">
            {cats.map((cat) => (
              <CategoryCard key={cat.slug} category={cat} />
            ))}
          </div>
        </section>
      )}

      {/* Товары */}
      <section className="mainpage--new sf-section">
        <div className="page-title">
          <h1>Новинки</h1>
        </div>
        {products.length > 0 ? (
          <div className="works-catalog">
            <div className="works-catalog-list works-catalog-list--blocks">
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
        ) : (
          <p className="sf-empty">Товары временно недоступны.</p>
        )}
      </section>
    </div>
  );
}
