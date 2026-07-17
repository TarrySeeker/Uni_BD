/**
 * Карточка товара carre (/product/<slug>, /en/…, /fr/…) — порт
 * frontend/views/catalog/view.twig. Слева галерея (work__slider-col), справа инфо
 * (work__info): категория, название, дизайнер, атрибуты, наличие, цена, кнопка
 * «В корзину», описание. Ниже — товары той же категории. Данные — Storefront API
 * (getProduct + getCategories + getSettings), локализованные по текущей локали.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProduct, getProducts, getCategories, getSettings } from '@/lib/api';
import {
  topLevelCategories,
  rootCategories,
  findCategoryPath,
  findCategory,
  categoryHref,
} from '@/lib/tree';
import { localizedHref, toLocale, alternatesFor } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import Breadcrumbs, { type Crumb } from '../../components/Breadcrumbs';
import Price from '../../components/Price';
import ProductCard from '../../components/ProductCard';
import ProductGallery from './ProductGallery';
import AddToCart from './AddToCart';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}): Promise<Metadata> {
  const { lang, slug } = await params;
  const locale = toLocale(lang);
  const product = await getProduct(slug, locale);
  if (!product) return { title: getDictionary(locale).notFound.productMetaTitle };
  return {
    title: product.meta.title ?? product.name,
    description: product.meta.description ?? undefined,
    alternates: alternatesFor(`/product/${slug}`, locale),
    robots: product.meta.noindex ? { index: false, follow: false } : undefined,
  };
}

/** Строковые/числовые атрибуты товара для блока work-head__about (машинные — пропускаем). */
function renderableAttributes(
  attributes: Record<string, unknown>,
): [string, string][] {
  return Object.entries(attributes)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => [k, String(v)] as [string, string]);
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) {
  const { lang, slug } = await params;
  const locale = toLocale(lang);
  const dict = getDictionary(locale);
  const [product, categories] = await Promise.all([
    getProduct(slug, locale),
    getCategories(locale),
  ]);
  if (!product) notFound();

  const top = topLevelCategories(categories);
  // Полные корни (с `catalog`) — по ним строятся вложенные URL как на проде.
  const roots = rootCategories(categories);

  const firstCatSlug = product.categories[0] ?? null;
  const catNode = firstCatSlug ? findCategory(top, firstCatSlug) : null;
  const categoryLabel = catNode?.name ?? '';

  // Хлебные крошки: Главная › Каталог › ...путь категории... › Товар
  const crumbs: Crumb[] = [{ label: dict.common.catalog, href: '/catalog' }];
  if (firstCatSlug) {
    for (const node of findCategoryPath(top, firstCatSlug)) {
      crumbs.push({ label: node.name, href: categoryHref(roots, node.slug) });
    }
  }
  crumbs.push({ label: product.name });

  const attrs = renderableAttributes(product.attributes);
  // Дисплейные цвето-свотчи (легаси carre `.wv__colors`); отбрасываем записи без hex.
  const colors = (product.colors ?? []).filter((c) => Boolean(c.hex));
  // Цена/старая цена рендерятся клиентским <Price> в выбранной валюте (мультивалюта).
  const showCompare = Boolean(product.onSale && product.compareAtPrice);

  // Товары той же категории (без текущего) — блок «того же раздела».
  const related =
    firstCatSlug
      ? (await getProducts({ category: firstCatSlug, limit: 7 }, locale)).data.filter(
          (p) => p.slug !== product.slug,
        ).slice(0, 6)
      : [];

  const primaryImage =
    product.media.find((m) => m.isPrimary && m.url)?.url ??
    product.media.find((m) => m.url)?.url ??
    null;

  return (
    <div className="work">
      <Breadcrumbs items={crumbs} locale={locale} homeLabel={dict.common.home} />

      <div className="work__head">
        <ProductGallery media={product.media} alt={product.name} />

        <div className="work__info">
          <div className="work-head">
            {categoryLabel && (
              <div className="work-head__category">{categoryLabel}</div>
            )}
            <h1 className="work-head__title">{product.name}</h1>
            {product.designer && (
              <h1 className="work-head__designer">{product.designer.name}</h1>
            )}
            {attrs.length > 0 && (
              <div className="work-head__about">
                {attrs.map(([k, v]) => (
                  <div key={k}>
                    {k}: {v}
                  </div>
                ))}
              </div>
            )}
            {colors.length > 0 && (
              <div className="wv__colors">
                {colors.map((c, i) => (
                  <div
                    key={`${c.hex}-${i}`}
                    className="wv__color"
                    style={{ background: c.hex }}
                    title={c.name || undefined}
                    aria-label={c.name || c.hex}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="work-cart">
            <div className="work-cart__exist">
              {product.inStock ? dict.product.inStock : dict.product.preorder}
            </div>
            <div className="work-cart__cnt_price">
              <div className="work-cart__price">
                {showCompare && (
                  <Price priceRub={product.compareAtPrice} className="sf-price-old" />
                )}
                <Price priceRub={product.price} />
              </div>
            </div>

            <AddToCart
              productId={product.id}
              slug={product.slug}
              name={product.name}
              price={Number(product.price)}
              image={primaryImage}
              maxQty={product.availableQty}
              inStock={product.inStock}
              addLabel={dict.product.addToCart}
              outLabel={dict.product.outOfStock}
              inCartLabel={dict.product.alreadyInCart}
              cartHref={localizedHref('/cart', locale)}
            />

            {product.description && (
              <div className="sf-product-descr">
                <div className="sf-product-descr__title">{dict.product.description}</div>
                <div className="sf-product-descr__body">{product.description}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <div className="work__other-sticky">
          <div className="work__other-sticky--head">
            <div className="work__other-sticky--head-title">
              {categoryLabel || dict.product.seeAlso}
            </div>
            <div className="works-catalog-list works-catalog-list--blocks">
              {related.map((p) => (
                <ProductCard key={p.slug} product={p} locale={locale} />
              ))}
            </div>
            {firstCatSlug && (
              <div className="work__other-sticky--all">
                <a href={localizedHref(categoryHref(roots, firstCatSlug), locale)}>
                  {dict.common.seeAll}
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
