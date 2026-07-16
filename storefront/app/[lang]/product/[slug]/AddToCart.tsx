'use client';

/**
 * Кнопка «В корзину» карточки товара (порт блока work-cart__btn-buy из
 * frontend/views/catalog/view.twig). Пишет в клиентскую корзину (localStorage,
 * lib/cart). Состояния: нет в наличии → disabled; уже в корзине → ссылка в корзину;
 * иначе — добавить. Реактивно следит за корзиной, чтобы отражать «Уже в корзине».
 *
 * i18n: подписи и ссылка на корзину приходят пропсами из серверной страницы товара
 * (она знает локаль и словарь) — компонент клиентский, но локаль-агностичен.
 */

import { useCart, addToCart } from '@/lib/cart';

interface Props {
  /** UUID товара в каталоге — для /cart/quote и /orders (anti-tamper). */
  productId: string;
  slug: string;
  name: string;
  price: number;
  image: string | null;
  maxQty: number;
  inStock: boolean;
  /** Подпись кнопки «В корзину» (локализованная). */
  addLabel?: string;
  /** Подпись disabled-кнопки «Нет в наличии». */
  outLabel?: string;
  /** Подпись «Уже в корзине». */
  inCartLabel?: string;
  /** Локализованная ссылка на корзину (`/cart`, `/en/cart`, …). */
  cartHref?: string;
}

export default function AddToCart({
  productId,
  slug,
  name,
  price,
  image,
  maxQty,
  inStock,
  addLabel = 'В корзину',
  outLabel = 'Нет в наличии',
  inCartLabel = 'Уже в корзине',
  cartHref = '/cart',
}: Props) {
  const { items, mounted } = useCart();
  const inCart = mounted && items.some((i) => i.slug === slug);

  if (!inStock) {
    return (
      <div className="work-cart__btn-buy">
        <button type="button" disabled>
          {outLabel}
        </button>
      </div>
    );
  }

  if (inCart) {
    return (
      <div className="work-cart__btn-buy">
        <a href={cartHref}>
          <button type="button">{inCartLabel}</button>
        </a>
      </div>
    );
  }

  return (
    <div className="work-cart__btn-buy">
      <button
        type="button"
        className="to-cart"
        onClick={() => addToCart({ productId, slug, name, price, image, maxQty })}
      >
        {addLabel}
      </button>
    </div>
  );
}
