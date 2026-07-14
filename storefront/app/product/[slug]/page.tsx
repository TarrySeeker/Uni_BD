/**
 * Карточка товара carre (/product/<slug>) — порт frontend/views/catalog/view.twig.
 * Слева галерея (work__slider-col), справа инфо (work__info): категория, название,
 * дизайнер, атрибуты, наличие, цена, кнопка «В корзину», описание. Ниже — товары той
 * же категории. Данные — Storefront API (getProduct + getCategories + getSettings).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProduct, getProducts, getCategories, getSettings } from '@/lib/api';
import { topLevelCategories, findCategoryPath, findCategory } from '@/lib/tree';
import { formatPrice } from '@/lib/format';
import Breadcrumbs, { type Crumb } from '../../components/Breadcrumbs';
import ProductCard from '../../components/ProductCard';
import ProductGallery from './ProductGallery';
import AddToCart from './AddToCart';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return { title: 'Товар не найден — carre' };
  return {
    title: product.meta.title ?? `${product.name} — carre`,
    description: product.meta.description ?? undefined,
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
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [product, categories, settings] = await Promise.all([
    getProduct(slug),
    getCategories(),
    getSettings(),
  ]);
  if (!product) notFound();

  const top = topLevelCategories(categories);
  const currencyCode = settings?.currency.code ?? 'RUB';
  const currencySym = settings?.currency.symbol ?? null;

  const firstCatSlug = product.categories[0] ?? null;
  const catNode = firstCatSlug ? findCategory(top, firstCatSlug) : null;
  const categoryLabel = catNode?.name ?? '';

  // Хлебные крошки: Главная › Каталог › ...путь категории... › Товар
  const crumbs: Crumb[] = [{ label: 'Каталог', href: '/catalog' }];
  if (firstCatSlug) {
    for (const node of findCategoryPath(top, firstCatSlug)) {
      crumbs.push({ label: node.name, href: `/catalog/${node.slug}` });
    }
  }
  crumbs.push({ label: product.name });

  const attrs = renderableAttributes(product.attributes);
  const priceStr = formatPrice(product.price, currencyCode, currencySym);
  const compareStr =
    product.onSale && product.compareAtPrice
      ? formatPrice(product.compareAtPrice, currencyCode, currencySym)
      : '';

  // Товары той же категории (без текущего) — блок «того же раздела».
  const related =
    firstCatSlug
      ? (await getProducts({ category: firstCatSlug, limit: 7 })).data.filter(
          (p) => p.slug !== product.slug,
        ).slice(0, 6)
      : [];

  const primaryImage =
    product.media.find((m) => m.isPrimary && m.url)?.url ??
    product.media.find((m) => m.url)?.url ??
    null;

  return (
    <div className="work">
      <Breadcrumbs items={crumbs} />

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
          </div>

          <div className="work-cart">
            <div className="work-cart__exist">
              {product.inStock ? 'В наличии' : 'Доступно по предзаказу'}
            </div>
            <div className="work-cart__cnt_price">
              <div className="work-cart__price">
                {compareStr && (
                  <span className="sf-price-old">{compareStr}</span>
                )}
                {priceStr}
              </div>
            </div>

            <AddToCart
              slug={product.slug}
              name={product.name}
              price={Number(product.price)}
              image={primaryImage}
              maxQty={product.availableQty}
              inStock={product.inStock}
            />

            {product.description && (
              <div className="sf-product-descr">
                <div className="sf-product-descr__title">Описание</div>
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
              {categoryLabel || 'Смотрите также'}
            </div>
            <div className="works-catalog-list works-catalog-list--blocks">
              {related.map((p) => (
                <ProductCard
                  key={p.slug}
                  product={p}
                  currencyCode={currencyCode}
                  currencySymbol={currencySym}
                />
              ))}
            </div>
            {firstCatSlug && (
              <div className="work__other-sticky--all">
                <a href={`/catalog/${firstCatSlug}`}>Смотреть всё</a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
