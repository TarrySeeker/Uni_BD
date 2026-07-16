'use client';

/**
 * Клиентская корзина витрины carre на localStorage (без БД — сама корзина живёт
 * в браузере; заказ уходит в Storefront API только на оформлении). Хранит минимум
 * для рендера строки корзины: slug/имя/цена(в рублях, число)/картинка/кол-во/остаток.
 *
 * Подписка — через нативный `storage` (синк между вкладками) + кастомное событие
 * `sf-cart-changed` (синк внутри вкладки). Хук `useCart` даёт React-состояние.
 */

import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';

export interface CartItem {
  slug: string;
  name: string;
  /** Цена за штуку в рублях (число). */
  price: number;
  image: string | null;
  qty: number;
  /** Максимум к заказу (остаток на складе); 0 → без явного лимита. */
  maxQty: number;
  /**
   * UUID товара в каталоге Admik. Нужен для серверного расчёта корзины
   * (/cart/quote) и создания заказа (/orders) — API принимает variantId/productId,
   * а не slug (anti-tamper: цену считает сервер по этому id). Опционален для
   * обратной совместимости со старыми записями корзины в localStorage; при
   * оформлении такие позиции отфильтровываются (нельзя оформить без id).
   */
  productId?: string;
}

const KEY = 'sf_cart_v1';
const EVENT = 'sf-cart-changed';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function readCart(): CartItem[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is CartItem =>
        i && typeof i.slug === 'string' && typeof i.qty === 'number',
    );
  } catch {
    return [];
  }
}

function writeCart(items: CartItem[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* quota/private-mode — деградируем молча */
  }
  window.dispatchEvent(new Event(EVENT));
}

function clampQty(qty: number, maxQty: number): number {
  let q = Math.max(1, Math.floor(qty));
  if (maxQty && maxQty > 0) q = Math.min(q, maxQty);
  return Math.min(q, 99);
}

/** Добавить товар (или увеличить количество, если уже в корзине). */
export function addToCart(item: Omit<CartItem, 'qty'>, qty = 1): void {
  const items = readCart();
  const existing = items.find((i) => i.slug === item.slug);
  if (existing) {
    existing.qty = clampQty(existing.qty + qty, item.maxQty);
    existing.maxQty = item.maxQty;
    existing.price = item.price;
    existing.name = item.name;
    existing.image = item.image;
    // Дополняем productId, если старая запись корзины его ещё не содержала.
    if (item.productId) existing.productId = item.productId;
  } else {
    items.push({ ...item, qty: clampQty(qty, item.maxQty) });
  }
  writeCart(items);
}

export function setQty(slug: string, qty: number): void {
  const items = readCart();
  const it = items.find((i) => i.slug === slug);
  if (!it) return;
  it.qty = clampQty(qty, it.maxQty);
  writeCart(items);
}

export function removeFromCart(slug: string): void {
  writeCart(readCart().filter((i) => i.slug !== slug));
}

export function clearCart(): void {
  writeCart([]);
}

export function cartSubtotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function cartCount(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.qty, 0);
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
let snapshot: CartItem[] = [];
let snapshotRaw = '';

function getSnapshot(): CartItem[] {
  if (!isBrowser()) return snapshot;
  const raw = window.localStorage.getItem(KEY) ?? '';
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = readCart();
  }
  return snapshot;
}

const EMPTY: CartItem[] = [];

/** Реактивный список позиций корзины (пустой на сервере/до маунта). */
export function useCart(): {
  items: CartItem[];
  count: number;
  subtotal: number;
  mounted: boolean;
  setItemQty: (slug: string, qty: number) => void;
  remove: (slug: string) => void;
  clear: () => void;
} {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const items = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY,
  );

  const setItemQty = useCallback((slug: string, qty: number) => setQty(slug, qty), []);
  const remove = useCallback((slug: string) => removeFromCart(slug), []);
  const clear = useCallback(() => clearCart(), []);

  return {
    items: mounted ? items : EMPTY,
    count: mounted ? cartCount(items) : 0,
    subtotal: mounted ? cartSubtotal(items) : 0,
    mounted,
    setItemQty,
    remove,
    clear,
  };
}
