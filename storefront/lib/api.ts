/**
 * Клиент публичного Storefront API Admik (`/api/storefront/v1/*`).
 *
 * ДВА АДРЕСА (docs/21 §0, docker-compose):
 *  - server-side (SSR / server components) → ADMIK_API_URL (http://app:3000 внутри
 *    docker-сети); наружу не выходит;
 *  - client-side → NEXT_PUBLIC_ADMIK_API_URL (https://admin.<домен>), впекается
 *    в клиентский бандл на этапе сборки.
 *
 * АВТОРИЗАЦИЯ (docs/21, lib/storefront/auth.ts — OR-логика): при server-side
 * запросе к http://app:3000 ОБЯЗАТЕЛЬНО слать заголовок `Origin` = домен витрины
 * (∈ STOREFRONT_ALLOWED_ORIGINS), иначе 401. Опционально X-Storefront-Key, если
 * магазин настроен на ключи.
 *
 * Деградация: любой сбой сети/парсинга → null / пустой список. Витрина всё равно
 * рендерит страницу (важно для healthcheck `GET /`).
 */

import type {
  CategoryDto,
  PageDto,
  ProductDetailDto,
  ProductListItemDto,
  ProductsResponse,
  PublicSettingsDto,
} from './types';

const SERVER_BASE = process.env.ADMIK_API_URL ?? 'http://app:3000';
const PUBLIC_BASE = process.env.NEXT_PUBLIC_ADMIK_API_URL ?? '';

/**
 * Origin витрины для server-side авторизации по allowlist. Берём из явного
 * STOREFRONT_ORIGIN, иначе публичного адреса сайта, иначе дефолт стенда.
 */
const STOREFRONT_ORIGIN =
  process.env.STOREFRONT_ORIGIN ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://erfgv.website';

const API_KEY = process.env.STOREFRONT_API_KEY ?? '';

/** База API в зависимости от среды исполнения (сервер/браузер). */
function apiBase(): string {
  if (typeof window === 'undefined') {
    return SERVER_BASE.replace(/\/$/, '');
  }
  return PUBLIC_BASE.replace(/\/$/, '');
}

function buildHeaders(): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Origin шлём только на сервере: в браузере его проставляет сам движок, а
  // ручная установка запрещена/игнорируется.
  if (typeof window === 'undefined') {
    headers.Origin = STOREFRONT_ORIGIN;
    if (API_KEY) {
      headers['X-Storefront-Key'] = API_KEY;
    }
  }
  return headers;
}

/**
 * GET к Storefront API. `cache: 'no-store'` → страница дин. рендерится по запросу
 * (не пытается фетчить при `next build` в docker, где app:3000 ещё не поднят).
 */
async function apiGet<T>(path: string): Promise<T | null> {
  const url = `${apiBase()}/api/storefront/v1${path}`;
  try {
    const res = await fetch(url, {
      headers: buildHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`[storefront-api] ${res.status} ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[storefront-api] fetch failed ${path}:`, (err as Error).message);
    return null;
  }
}

/** Настройки/брендинг магазина (core — доступно всегда). */
export async function getSettings(): Promise<PublicSettingsDto | null> {
  const body = await apiGet<{ data: PublicSettingsDto }>('/settings');
  return body?.data ?? null;
}

/** Дерево категорий (только активные). */
export async function getCategories(): Promise<CategoryDto[]> {
  const body = await apiGet<{ data: CategoryDto[] }>('/categories');
  return body?.data ?? [];
}

export interface ProductQuery {
  limit?: number;
  offset?: number;
  category?: string;
  featured?: boolean;
  isNew?: boolean;
  sale?: boolean;
  /** Сортировка каталога (carre: asc/desc/name/new или сырой ProductSort). */
  sort?: string;
  /** Полнотекстовый поиск (ILIKE по name/sku на стороне API, параметр ?q). */
  search?: string;
}

/** Список товаров с пагинацией/фильтрами. */
export async function getProducts(
  query: ProductQuery = {},
): Promise<ProductsResponse> {
  const params = new URLSearchParams();
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.offset != null) params.set('offset', String(query.offset));
  if (query.category) params.set('category', query.category);
  if (query.featured) params.set('featured', '1');
  if (query.isNew) params.set('new', '1');
  if (query.sale) params.set('sale', '1');
  if (query.sort) params.set('sort', query.sort);
  if (query.search) params.set('q', query.search);
  const qs = params.toString();
  const body = await apiGet<ProductsResponse>(`/products${qs ? `?${qs}` : ''}`);
  return body ?? { data: [], pagination: { total: 0, limit: 0, offset: 0, count: 0 } };
}

/** Карточка товара по slug (или null, если не найдено/не активно/сбой сети). */
export async function getProduct(slug: string): Promise<ProductDetailDto | null> {
  const body = await apiGet<{ data: ProductDetailDto }>(
    `/products/${encodeURIComponent(slug)}`,
  );
  return body?.data ?? null;
}

/**
 * CMS-страница по slug (или null: не найдено/не published/сбой сети → apiGet
 * вернёт null на !ok). `locale` пробрасывается в API query-параметром — сервер
 * локализует title/SEO/контент секций (?locale имеет приоритет над Accept-Language;
 * docs/21). Пусто → дефолтная локаль магазина.
 */
export async function getPage(
  slug: string,
  locale?: string,
): Promise<PageDto | null> {
  const qs = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  const body = await apiGet<{ data: PageDto }>(
    `/pages/${encodeURIComponent(slug)}${qs}`,
  );
  return body?.data ?? null;
}

/**
 * Товары для «избранной» сетки главной: сперва featured, при пустом результате —
 * общий список (fallback), чтобы витрина всегда показывала реальные товары.
 */
export async function getHomeProducts(limit = 12): Promise<ProductListItemDto[]> {
  const featured = await getProducts({ featured: true, limit });
  if (featured.data.length > 0) {
    return featured.data;
  }
  const latest = await getProducts({ limit });
  return latest.data;
}

/**
 * Товары блока «Новинки» главной (carre `.mainpage--new`): сперва помеченные
 * `is_new` (?new=1), при пустом результате — общий список (fallback), чтобы блок
 * всегда показывал реальные товары, даже если магазин не проставил флаг новинки.
 */
export async function getNewProducts(limit = 12): Promise<ProductListItemDto[]> {
  const fresh = await getProducts({ isNew: true, limit });
  if (fresh.data.length > 0) {
    return fresh.data;
  }
  const latest = await getProducts({ limit });
  return latest.data;
}
