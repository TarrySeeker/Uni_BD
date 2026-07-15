/**
 * Рендерер секций CMS-страницы (docs/11 §5.1.4, ADR-012). Маппит каждую секцию по
 * дискриминатору `type` в разметку carre (классы из /dist/app.css + /storefront.css).
 *
 * Секции приходят из Storefront API уже: только enabled, отсортированы по порядку,
 * с публичными URL изображений (imageKey → imageUrl на стороне API). Rich-text-поля
 * (text.html, hero.html, faq.a, cta.html) сервер-санитизированы Admik перед записью
 * (lib/cms/sanitize.ts) — поэтому безопасны для dangerouslySetInnerHTML.
 *
 * products_grid НЕ несёт товаров (модули cms/catalog независимы, инвариант 5.1):
 * витрина дотягивает их существующими фетчерами каталога по slug-фильтру. Компонент
 * серверный/async — товары резолвятся до рендера (Promise.all по грид-секциям).
 */

import { getProduct, getProducts } from '@/lib/api';
import type {
  PageSection,
  ProductDetailDto,
  ProductListItemDto,
  SectionContentByType,
} from '@/lib/types';
import ProductCard from '../ProductCard';

interface Props {
  sections: PageSection[];
  currencyCode: string;
  currencySymbol: string | null;
}

/** ProductDetailDto (из getProduct по slug) → форма карточки списка. */
function detailToListItem(p: ProductDetailDto): ProductListItemDto {
  const imageUrl =
    p.media.find((m) => m.isPrimary && m.url)?.url ??
    p.media.find((m) => m.url)?.url ??
    null;
  return {
    slug: p.slug,
    name: p.name,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    discountPct: p.discountPct,
    onSale: p.onSale,
    isNew: p.isNew,
    isFeatured: p.isFeatured,
    brand: p.brand,
    imageUrl,
    inStock: p.inStock,
    availableQty: p.availableQty,
  };
}

/**
 * Резолвит товары для products_grid через существующие фетчеры каталога:
 *  - category → /products?category=<slug> (limit);
 *  - slugs → /products/<slug> по каждому (сохраняя порядок, отбрасывая ненайденные);
 *  - brand → НЕ поддержано публичным API (нужен brandId-uuid, /brands его не отдаёт,
 *    slug-фильтра у /products нет) ⇒ пустой список. См. отчёт M2 (ограничение).
 */
async function resolveGridProducts(
  content: SectionContentByType['products_grid'],
): Promise<ProductListItemDto[]> {
  const limit = content.limit ?? 12;

  if (content.mode === 'category' && content.categorySlug) {
    const res = await getProducts({ category: content.categorySlug, limit });
    return res.data;
  }

  if (content.mode === 'slugs' && content.slugs?.length) {
    const found = await Promise.all(
      content.slugs.slice(0, limit).map((slug) => getProduct(slug)),
    );
    return found
      .filter((p): p is ProductDetailDto => p !== null)
      .map(detailToListItem);
  }

  // mode === 'brand' (или неполный фильтр) — не резолвится публичным API.
  return [];
}

/** Одна секция → разметка. products — предрезолвленные товары для products_grid. */
function Section({
  section,
  products,
  currencyCode,
  currencySymbol,
}: {
  section: PageSection;
  products: ProductListItemDto[] | null;
  currencyCode: string;
  currencySymbol: string | null;
}) {
  switch (section.type) {
    case 'text':
      return (
        <div
          className="sf-cms about__text"
          dangerouslySetInnerHTML={{ __html: section.content.html }}
        />
      );

    case 'hero': {
      const c = section.content;
      return (
        <section className="sf-cms-hero">
          {c.imageUrl && (
            <img className="sf-cms-hero__image" src={c.imageUrl} alt={c.title} />
          )}
          <div className="sf-cms-hero__body">
            <h2 className="sf-cms-hero__title">{c.title}</h2>
            {c.subtitle && <p className="sf-cms-hero__subtitle">{c.subtitle}</p>}
            {c.html && (
              <div
                className="sf-cms"
                dangerouslySetInnerHTML={{ __html: c.html }}
              />
            )}
            {c.ctaLabel && c.ctaHref && (
              <a className="sf-hero__cta" href={c.ctaHref}>
                {c.ctaLabel} →
              </a>
            )}
          </div>
        </section>
      );
    }

    case 'banner': {
      const c = section.content;
      if (!c.imageUrl) return null;
      const img = (
        <img className="sf-cms-banner__image" src={c.imageUrl} alt={c.alt ?? ''} />
      );
      return (
        <div className="sf-cms-banner">
          {c.href ? <a href={c.href}>{img}</a> : img}
        </div>
      );
    }

    case 'gallery': {
      const images = section.content.images.filter((i) => i.imageUrl);
      if (images.length === 0) return null;
      return (
        <div className="sf-cms-gallery">
          {images.map((img, i) => (
            <figure className="sf-cms-gallery__item" key={i}>
              <img src={img.imageUrl} alt={img.alt ?? ''} />
            </figure>
          ))}
        </div>
      );
    }

    case 'faq':
      return (
        <div className="sf-cms-faq accordion">
          {section.content.items.map((item, i) => (
            <details className="sf-faq-item" key={i}>
              <summary className="accordion__title">{item.q}</summary>
              <div
                className="accordion__body"
                dangerouslySetInnerHTML={{ __html: item.a }}
              />
            </details>
          ))}
        </div>
      );

    case 'products_grid': {
      const list = products ?? [];
      if (list.length === 0) return null;
      return (
        <section className="sf-section sf-cms-products">
          {section.content.title && (
            <div className="page-title">
              <h1>{section.content.title}</h1>
            </div>
          )}
          <div className="works-catalog">
            <div className="works-catalog-list works-catalog-list--blocks">
              {list.map((p) => (
                <ProductCard
                  key={p.slug}
                  product={p}
                  currencyCode={currencyCode}
                  currencySymbol={currencySymbol}
                />
              ))}
            </div>
          </div>
        </section>
      );
    }

    case 'cta': {
      const c = section.content;
      return (
        <section className="sf-cms-cta">
          <h2 className="sf-cms-cta__title">{c.title}</h2>
          {c.html && (
            <div
              className="sf-cms"
              dangerouslySetInnerHTML={{ __html: c.html }}
            />
          )}
          <a className="sf-hero__cta" href={c.buttonHref}>
            {c.buttonLabel} →
          </a>
        </section>
      );
    }

    default:
      // Неизвестный тип секции (форвард-совместимость) — молча пропускаем.
      return null;
  }
}

export default async function PageSections({
  sections,
  currencyCode,
  currencySymbol,
}: Props) {
  // Предрезолв товаров для products_grid-секций (индексы совпадают с sections).
  const gridProducts = await Promise.all(
    sections.map((s) =>
      s.type === 'products_grid'
        ? resolveGridProducts(s.content)
        : Promise.resolve(null),
    ),
  );

  return (
    <div className="sf-cms-sections">
      {sections.map((section, i) => (
        <Section
          key={i}
          section={section}
          products={gridProducts[i]}
          currencyCode={currencyCode}
          currencySymbol={currencySymbol}
        />
      ))}
    </div>
  );
}
