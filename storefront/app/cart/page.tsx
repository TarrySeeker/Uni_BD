'use client';

/**
 * Корзина carre (/cart) — клиентская, на localStorage (порт frontend/views/cart/
 * index.twig). Список позиций, счётчик количества (±, с лимитом остатка), удаление,
 * итог и кнопка оформления. Классы cart-* сохранены 1:1 для стиля app.css.
 * Оформление ведёт на /cart/order (шаг чекаута — вне этой задачи).
 */

import { useCart } from '@/lib/cart';
import { formatPrice } from '@/lib/format';

export default function CartPage() {
  const { items, subtotal, mounted, setItemQty, remove } = useCart();

  const title = (
    <div className="page-title">
      <h1>Корзина</h1>
    </div>
  );

  // До маунта (SSR/первый рендер) не знаем содержимое localStorage — чтобы не
  // рвать гидрацию, показываем только заголовок.
  if (!mounted) return title;

  if (items.length === 0) {
    return (
      <>
        {title}
        <h3 className="text-center">Ваша корзина пуста :(</h3>
      </>
    );
  }

  return (
    <>
      {title}
      <div className="cart">
        <div className="cart-head">
          <div className="cart-head--info">Товар</div>
          <div className="cart-head--price">Стоимость</div>
          <div className="cart-head--cnt">Количество</div>
          <div className="cart-head--fullprice">Итого</div>
        </div>

        {items.map((item) => {
          const minusDisabled = item.qty < 2;
          const plusDisabled =
            item.qty >= 99 || (item.maxQty > 0 && item.qty >= item.maxQty);
          return (
            <div
              className="cart-body cart-list-item"
              data-id={item.slug}
              key={item.slug}
            >
              <div className="cart-body--info">
                <a href={`/product/${item.slug}`} className="cart-body--info-img">
                  {item.image && <img src={item.image} alt="" />}
                </a>
                <div className="cart-body--info-work">
                  <a href={`/product/${item.slug}`} className="info-work--name">
                    {item.name}
                  </a>
                </div>
              </div>
              <div className="cart-body--price">{formatPrice(item.price)}</div>
              <div className="cart-body--cnt">
                <div
                  className={`minus product-counter__minus${
                    minusDisabled ? ' is-disabled' : ''
                  }`}
                  onClick={() => !minusDisabled && setItemQty(item.slug, item.qty - 1)}
                />
                <input
                  className="cart-body--cnt-value"
                  readOnly
                  value={item.qty}
                />
                <div
                  className={`plus product-counter__plus${
                    plusDisabled ? ' is-disabled' : ''
                  }`}
                  onClick={() => !plusDisabled && setItemQty(item.slug, item.qty + 1)}
                />
              </div>
              <div className="cart-body--fullprice">
                <span className="cart-list-item__sum">
                  {formatPrice(item.price * item.qty)}
                </span>
              </div>
              <div className="cart-body--del">
                <div
                  className="del"
                  onClick={() => remove(item.slug)}
                  role="button"
                  aria-label="Удалить"
                />
              </div>
            </div>
          );
        })}

        <div className="cart-foot" id="cart-footer">
          <a href="/cart/order" className="cart-foot--buy">
            Оформить заказ →
          </a>
          <div className="cart-foot--fullprice">
            <span className="cart-list__total">{formatPrice(subtotal)}</span>
          </div>
          <div className="cart-foot--itogo-sm">
            <div className="itogo-sm--name">Итого</div>
            <div className="itogo-sm--fullprice">
              <span className="cart-list__total">{formatPrice(subtotal)}</span>
            </div>
          </div>
        </div>

        <a href="/cart/order" className="cart--button-buy">
          Оформить заказ →
        </a>
      </div>
    </>
  );
}
