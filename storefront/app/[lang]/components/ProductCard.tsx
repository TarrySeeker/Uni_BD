/**
 * Карточка товара в сетке — порт из frontend/views/works/__item.twig (классы
 * .work-box / .work-item сохранены 1:1, стиль берётся из app.css carre).
 * i18n: ссылка на товар локализуется через localizedHref (сохраняет текущую локаль).
 */

import type { ProductListItemDto } from '@/lib/types';
import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import Price from './Price';
import FavoriteButton from './FavoriteButton';

interface Props {
  product: ProductListItemDto;
  /** Текущая локаль витрины — для локализации ссылки на товар. */
  locale?: Locale;
  /**
   * Устаревшие пропсы валюты (currencyCode/currencySymbol) больше не нужны: цена
   * рендерится клиентским <Price> в ВЫБРАННОЙ валюте (мультивалюта). Оставлены
   * опциональными для обратной совместимости вызовов (игнорируются).
   */
  currencyCode?: string;
  currencySymbol?: string | null;
}

export default function ProductCard({ product, locale = DEFAULT_LOCALE }: Props) {
  const url = localizedHref(`/product/${product.slug}`, locale);
  return (
    <div className="work-box">
      <a href={url} className="work-item">
        <div
          className="work-item__image"
          style={
            product.imageUrl
              ? { backgroundImage: `url('${product.imageUrl}')` }
              : undefined
          }
        />
        <div className="work-item__name">{product.brand?.name ?? ' '}</div>
        <div className="work-item__description">{product.name}</div>
        <div className="work-item__price">
          {product.inStock ? (
            <Price priceRub={product.price} displayPrices={product.displayPrices} />
          ) : (
            ' '
          )}
        </div>
        <FavoriteButton
          item={{
            slug: product.slug,
            name: product.name,
            price: product.price,
            compareAtPrice: product.compareAtPrice,
            imageUrl: product.imageUrl,
            brandName: product.brand?.name ?? null,
            url,
          }}
        />
      </a>
    </div>
  );
}
