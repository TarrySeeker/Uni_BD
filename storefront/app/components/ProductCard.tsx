/**
 * Карточка товара в сетке — порт из frontend/views/works/__item.twig (классы
 * .work-box / .work-item сохранены 1:1, стиль берётся из app.css carre).
 */

import type { ProductListItemDto } from '@/lib/types';
import { formatPrice } from '@/lib/format';

interface Props {
  product: ProductListItemDto;
  currencyCode?: string;
  currencySymbol?: string | null;
}

export default function ProductCard({ product, currencyCode, currencySymbol }: Props) {
  return (
    <div className="work-box">
      <a href={`/product/${product.slug}`} className="work-item">
        <div
          className="work-item__image"
          style={
            product.imageUrl
              ? { backgroundImage: `url('${product.imageUrl}')` }
              : undefined
          }
        />
        <div className="work-item__name">{product.brand?.name ?? ' '}</div>
        <div className="work-item__description">{product.name}</div>
        <div className="work-item__price">
          {product.inStock ? formatPrice(product.price, currencyCode, currencySymbol) : ' '}
        </div>
        <div className="work-item__heart" />
      </a>
    </div>
  );
}
