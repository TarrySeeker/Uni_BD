'use client';

/**
 * Кнопка «В корзину» карточки товара (порт блока work-cart__btn-buy из
 * frontend/views/catalog/view.twig). Пишет в клиентскую корзину (localStorage,
 * lib/cart). Состояния: нет в наличии → disabled; уже в корзине → ссылка в корзину;
 * иначе — добавить. Реактивно следит за корзиной, чтобы отражать «Уже в корзине».
 */

import { useCart, addToCart } from '@/lib/cart';

interface Props {
  slug: string;
  name: string;
  price: number;
  image: string | null;
  maxQty: number;
  inStock: boolean;
}

export default function AddToCart({
  slug,
  name,
  price,
  image,
  maxQty,
  inStock,
}: Props) {
  const { items, mounted } = useCart();
  const inCart = mounted && items.some((i) => i.slug === slug);

  if (!inStock) {
    return (
      <div className="work-cart__btn-buy">
        <button type="button" disabled>
          Нет в наличии
        </button>
      </div>
    );
  }

  if (inCart) {
    return (
      <div className="work-cart__btn-buy">
        <a href="/cart">
          <button type="button">Уже в корзине</button>
        </a>
      </div>
    );
  }

  return (
    <div className="work-cart__btn-buy">
      <button
        type="button"
        className="to-cart"
        onClick={() => addToCart({ slug, name, price, image, maxQty })}
      >
        В корзину
      </button>
    </div>
  );
}
