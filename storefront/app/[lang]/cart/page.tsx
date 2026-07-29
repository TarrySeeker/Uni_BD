'use client';

/**
 * Корзина carre (/cart) — клиентская, на localStorage (порт frontend/views/cart/
 * index.twig). Список позиций, счётчик количества (±, с лимитом остатка), удаление,
 * итог и кнопка оформления. Классы cart-* сохранены 1:1 для стиля app.css.
 * Оформление ведёт на /cart/order (шаг чекаута — вне этой задачи).
 */

import { useParams } from 'next/navigation';
import { useCart } from '@/lib/cart';
import { formatDisplayPrice } from '@/lib/format';
import { useCurrency } from '@/lib/currency';
import { localizedHref, toLocale } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';

export default function CartPage() {
  const { items, subtotal, mounted, setItemQty, remove } = useCart();
  const { selected, currencies } = useCurrency();
  // Базовая валюта магазина — первая в списке (см. availableCurrencies). Она несёт
  // формат чисел и знаки после запятой ИЗ НАСТРОЕК (№9).
  const base = currencies[0] ?? selected;
  const locale = toLocale(useParams().lang);
  const dict = getDictionary(locale);
  const href = (path: string) => localizedHref(path, locale);
  // Позиции показываем в ВЫБРАННОЙ валюте (мультивалюта). Цены в корзине — рубли.
  const showPrice = (rub: number) => formatDisplayPrice(rub, selected);
  // ИТОГ к оплате — ВСЕГДА в БАЗОВОЙ валюте магазина (в ней и эквайринг), но
  // формат чисел/знаков — из настроек магазина (№9), а не зашитый русский.
  const payTotal = formatDisplayPrice(subtotal, base);
  // Если выбрана НЕ базовая валюта — показываем итог в ней справочно.
  const isBase = selected.rate === 1;

  const title = (
    <div className="page-title">
      <h1>{dict.cart.title}</h1>
    </div>
  );

  // До маунта (SSR/первый рендер) не знаем содержимое localStorage — чтобы не
  // рвать гидрацию, показываем только заголовок.
  if (!mounted) return title;

  if (items.length === 0) {
    return (
      <>
        {title}
        <h3 className="text-center">{dict.cart.empty}</h3>
      </>
    );
  }

  return (
    <>
      {title}
      <div className="cart">
        <div className="cart-head">
          <div className="cart-head--info">{dict.cart.colProduct}</div>
          <div className="cart-head--price">{dict.cart.colPrice}</div>
          <div className="cart-head--cnt">{dict.cart.colQty}</div>
          <div className="cart-head--fullprice">{dict.cart.colTotal}</div>
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
                <a href={href(`/product/${item.slug}`)} className="cart-body--info-img">
                  {item.image && <img src={item.image} alt="" />}
                </a>
                <div className="cart-body--info-work">
                  <a href={href(`/product/${item.slug}`)} className="info-work--name">
                    {item.name}
                  </a>
                </div>
              </div>
              <div className="cart-body--price">{showPrice(item.price)}</div>
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
                  {showPrice(item.price * item.qty)}
                </span>
              </div>
              <div className="cart-body--del">
                <div
                  className="del"
                  onClick={() => remove(item.slug)}
                  role="button"
                  aria-label={dict.cart.remove}
                />
              </div>
            </div>
          );
        })}

        <div className="cart-foot" id="cart-footer">
          <a href={href('/cart/order')} className="cart-foot--buy">
            {dict.cart.checkout}
          </a>
          <div className="cart-foot--fullprice">
            {/* ИТОГ к оплате — всегда в рублях (эквайринг рублёвый). */}
            <span className="cart-list__total">{payTotal}</span>
            {!isBase && (
              <span className="cart-list__total-hint"> ≈ {showPrice(subtotal)}</span>
            )}
          </div>
          <div className="cart-foot--itogo-sm">
            <div className="itogo-sm--name">{dict.cart.grandTotal}</div>
            <div className="itogo-sm--fullprice">
              <span className="cart-list__total">{payTotal}</span>
              {!isBase && (
                <span className="cart-list__total-hint"> ≈ {showPrice(subtotal)}</span>
              )}
            </div>
          </div>
        </div>

        <a href={href('/cart/order')} className="cart--button-buy">
          {dict.cart.checkout}
        </a>
      </div>
    </>
  );
}
