'use client';

/**
 * Избранное carre (/favorite) — клиентское, на localStorage (порт frontend/views/
 * works/index.twig под список желаний). Сетка карточек .work-box/.work-item той же
 * формы, что ProductCard, но рендерится из снапшота lib/favorites (без API). Клик по
 * сердечку убирает товар из избранного. Классы works-catalog-* сохранены 1:1 для app.css.
 */

import { useEffect } from 'react';
import { formatPrice } from '@/lib/format';
import { useFavorites } from '@/lib/favorites';
import FavoriteButton from '../components/FavoriteButton';

export default function FavoritePage() {
  // Помечаем страницу как каталожную (в оригинале carre body.page--catalog).
  useEffect(() => {
    document.body.classList.add('page--catalog');
    return () => document.body.classList.remove('page--catalog');
  }, []);

  const { items, mounted } = useFavorites();

  const title = (
    <div className="page-title">
      <h1>Избранное</h1>
    </div>
  );

  // До маунта (SSR/первый рендер) содержимое localStorage неизвестно — показываем
  // только заголовок, чтобы не рвать гидрацию (как /cart).
  if (!mounted) return title;

  if (items.length === 0) {
    return (
      <>
        {title}
        <div className="sf-empty">
          В избранном пока пусто. <a href="/catalog">Перейти в каталог →</a>
        </div>
      </>
    );
  }

  return (
    <>
      {title}
      <div className="works-catalog sf-favorites">
        <div className="works-catalog-list works-catalog-list--blocks">
          {items.map((item) => (
            <div className="work-box" key={item.slug}>
              <a href={item.url} className="work-item">
                <div
                  className="work-item__image"
                  style={
                    item.imageUrl
                      ? { backgroundImage: `url('${item.imageUrl}')` }
                      : undefined
                  }
                />
                <div className="work-item__name">{item.brandName ?? ' '}</div>
                <div className="work-item__description">{item.name}</div>
                <div className="work-item__price">
                  {item.compareAtPrice && (
                    <span className="sf-price-old">{formatPrice(item.compareAtPrice)}</span>
                  )}
                  {formatPrice(item.price)}
                </div>
                <FavoriteButton item={item} />
              </a>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
