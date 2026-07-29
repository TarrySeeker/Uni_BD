'use client';

/**
 * Сердечко карточки товара (порт .work-item__heart из frontend/views/works/
 * __item.twig). Тоггл клиентского «Избранного» (localStorage, lib/favorites).
 * Карточка обёрнута в <a>, поэтому клик по сердечку гасим (preventDefault/
 * stopPropagation), чтобы не уйти на страницу товара. Активное состояние —
 * класс `is-active` (в app.css меняет иконку на heart-black.svg).
 */

import type { FavoriteItem } from '@/lib/favorites';
import { useFavorites } from '@/lib/favorites';
import { getDictionary } from '@/lib/dictionaries';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

export default function FavoriteButton({
  item,
  locale = DEFAULT_LOCALE,
}: {
  item: FavoriteItem;
  /**
   * Локаль нужна из-за подписи для скринридера: без неё англо- и франкоязычный
   * покупатель слышал у каждой карточки русское «В избранное» (находка 29.07).
   * Значение по умолчанию оставляет вызовы без локали рабочими.
   */
  locale?: Locale;
}) {
  const { has, toggle } = useFavorites();
  const active = has(item.slug);
  const d = getDictionary(locale);

  return (
    <div
      className={`work-item__heart js-to-fav${active ? ' is-active' : ''}`}
      data-id={item.slug}
      role="button"
      aria-pressed={active}
      aria-label={active ? d.favorite.remove : d.favorite.add}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(item);
      }}
    />
  );
}
