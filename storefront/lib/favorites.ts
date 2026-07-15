'use client';

/**
 * Клиентское «Избранное» витрины carre на localStorage (без БД — список желаний
 * живёт в браузере). Снапшот хранит ровно то, что нужно карточке товара для
 * рендера БЕЗ обращения к API: slug/имя/цена(строка NUMERIC в рублях)/старая
 * цена/картинка/имя бренда(дизайнера)/ссылка. Точная калька lib/cart.ts.
 *
 * Подписка — через нативный `storage` (синк между вкладками) + кастомное событие
 * `sf-favorites-changed` (синк внутри вкладки). Хук `useFavorites` даёт React-состояние.
 */

import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';

export interface FavoriteItem {
  slug: string;
  name: string;
  /** Цена в рублях строкой NUMERIC (как ProductListItemDto.price), напр. "7500.00". */
  price: string;
  /** Старая цена (для перечёркивания), если есть скидка. */
  compareAtPrice?: string | null;
  imageUrl: string | null;
  /** Имя бренда/дизайнера — верхняя строка карточки. */
  brandName: string | null;
  /** Ссылка на страницу товара (напр. `/product/<slug>`). */
  url: string;
}

const KEY = 'carre_favorites_v1';
const EVENT = 'sf-favorites-changed';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function readFavorites(): FavoriteItem[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is FavoriteItem =>
        i && typeof i.slug === 'string' && typeof i.name === 'string',
    );
  } catch {
    return [];
  }
}

function writeFavorites(items: FavoriteItem[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* quota/private-mode — деградируем молча */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function isFavorite(slug: string): boolean {
  return readFavorites().some((i) => i.slug === slug);
}

/** Добавить в избранное (если ещё нет) или убрать (если уже есть). Возвращает новое состояние. */
export function toggleFavorite(item: FavoriteItem): boolean {
  const items = readFavorites();
  const exists = items.some((i) => i.slug === item.slug);
  if (exists) {
    writeFavorites(items.filter((i) => i.slug !== item.slug));
    return false;
  }
  items.push(item);
  writeFavorites(items);
  return true;
}

export function removeFavorite(slug: string): void {
  writeFavorites(readFavorites().filter((i) => i.slug !== slug));
}

export function clearFavorites(): void {
  writeFavorites([]);
}

/* ---- React-подписка -------------------------------------------------------- */

function subscribe(cb: () => void): () => void {
  if (!isBrowser()) return () => {};
  window.addEventListener('storage', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener(EVENT, cb);
  };
}

/**
 * Кэш снапшота: useSyncExternalStore требует стабильную ссылку между вызовами,
 * иначе бесконечный ре-рендер. Обновляем кэш только когда содержимое поменялось.
 */
let snapshot: FavoriteItem[] = [];
let snapshotRaw = '';

function getSnapshot(): FavoriteItem[] {
  if (!isBrowser()) return snapshot;
  const raw = window.localStorage.getItem(KEY) ?? '';
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = readFavorites();
  }
  return snapshot;
}

const EMPTY: FavoriteItem[] = [];

/** Реактивный список избранного (пустой на сервере/до маунта). */
export function useFavorites(): {
  items: FavoriteItem[];
  count: number;
  mounted: boolean;
  toggle: (item: FavoriteItem) => void;
  has: (slug: string) => boolean;
  remove: (slug: string) => void;
} {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const raw = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  const items = mounted ? raw : EMPTY;

  const toggle = useCallback((item: FavoriteItem) => toggleFavorite(item), []);
  const remove = useCallback((slug: string) => removeFavorite(slug), []);
  const has = useCallback((slug: string) => items.some((i) => i.slug === slug), [items]);

  return {
    items,
    count: items.length,
    mounted,
    toggle,
    has,
    remove,
  };
}
