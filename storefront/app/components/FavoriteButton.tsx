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

export default function FavoriteButton({ item }: { item: FavoriteItem }) {
  const { has, toggle } = useFavorites();
  const active = has(item.slug);

  return (
    <div
      className={`work-item__heart js-to-fav${active ? ' is-active' : ''}`}
      data-id={item.slug}
      role="button"
      aria-pressed={active}
      aria-label={active ? 'Убрать из избранного' : 'В избранное'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(item);
      }}
    />
  );
}
