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
  FullDesignerDto,
  PageDto,
  PageListItemDto,
  ProductDetailDto,
  ProductListItemDto,
  ProductsResponse,
  PublicSettingsDto,
  CartQuoteRequest,
  CreateOrderRequest,
  QuoteDto,
  OrderCreatedDto,
  OrderPublicDto,
  PaymentInitDto,
  CdekCityDto,
  CdekPvzDto,
  StorefrontApiError,
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

/**
 * Дописывает `?locale=<code>` (или `&locale=`) к пути. Пустая локаль — не трогаем
 * (сервер применит дефолтную локаль магазина). Сервер локализует title/SEO/контент
 * секций и переводы каталога/CMS; `?locale` приоритетнее Accept-Language (docs/21).
 */
function withLocale(path: string, locale?: string): string {
  if (!locale) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}locale=${encodeURIComponent(locale)}`;
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

/** Настройки/брендинг магазина (core — доступно всегда). Локализует home-контент/SEO. */
export async function getSettings(locale?: string): Promise<PublicSettingsDto | null> {
  const body = await apiGet<{ data: PublicSettingsDto }>(withLocale('/settings', locale));
  return body?.data ?? null;
}

/** Дерево категорий (только активные). `locale` → локализованные названия категорий. */
export async function getCategories(locale?: string): Promise<CategoryDto[]> {
  const body = await apiGet<{ data: CategoryDto[] }>(withLocale('/categories', locale));
  return body?.data ?? [];
}

export interface ProductQuery {
  limit?: number;
  offset?: number;
  category?: string;
  /** Slug дизайнера — товары одной персоны для страницы /designers/{slug} (M4.1). */
  designer?: string;
  featured?: boolean;
  isNew?: boolean;
  sale?: boolean;
  /** Сортировка каталога (carre: asc/desc/name/new или сырой ProductSort). */
  sort?: string;
  /** Полнотекстовый поиск (ILIKE по name/sku на стороне API, параметр ?q). */
  search?: string;
}

/** Список товаров с пагинацией/фильтрами. `locale` → локализованные name/brand. */
export async function getProducts(
  query: ProductQuery = {},
  locale?: string,
): Promise<ProductsResponse> {
  const params = new URLSearchParams();
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.offset != null) params.set('offset', String(query.offset));
  if (query.category) params.set('category', query.category);
  if (query.designer) params.set('designer', query.designer);
  if (query.featured) params.set('featured', '1');
  if (query.isNew) params.set('new', '1');
  if (query.sale) params.set('sale', '1');
  if (query.sort) params.set('sort', query.sort);
  if (query.search) params.set('q', query.search);
  if (locale) params.set('locale', locale);
  const qs = params.toString();
  const body = await apiGet<ProductsResponse>(`/products${qs ? `?${qs}` : ''}`);
  return body ?? { data: [], pagination: { total: 0, limit: 0, offset: 0, count: 0 } };
}

/** Карточка товара по slug (или null, если не найдено/не активно/сбой сети). */
export async function getProduct(
  slug: string,
  locale?: string,
): Promise<ProductDetailDto | null> {
  const body = await apiGet<{ data: ProductDetailDto }>(
    withLocale(`/products/${encodeURIComponent(slug)}`, locale),
  );
  return body?.data ?? null;
}

/**
 * Публичная страница дизайнера по slug (или null: не найден/не активен/сбой сети).
 * Возвращает FullDesignerDto (имя, био, фото, соцсети, workCount, SEO-мета).
 * `locale` → локализованные био/страна/SEO-мета дизайнера.
 */
export async function getDesigner(
  slug: string,
  locale?: string,
): Promise<FullDesignerDto | null> {
  const body = await apiGet<{ data: FullDesignerDto }>(
    withLocale(`/designers/${encodeURIComponent(slug)}`, locale),
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
 * Список опубликованных CMS-страниц (slug/title/SEO + признак бокового меню).
 *
 * Источник пунктов вертикального меню разделов на доп-страницах: витрина не
 * знает состава страниц магазина и знать не должна (мультитенантность) — она
 * фильтрует по флагу showInNav, который владелец ставит в админке. Сбой сети /
 * выключенный модуль cms → пустой массив: боковик не рисуется, сама страница
 * (её данные приходят отдельным запросом getPage) остаётся рабочей.
 */
export async function getPages(locale?: string): Promise<PageListItemDto[]> {
  const body = await apiGet<{ data: PageListItemDto[] }>(withLocale('/pages', locale));
  return body?.data ?? [];
}

/**
 * Список активных дизайнеров (эндпоинт отдаёт только is_active). Нужен карте сайта:
 * страницы `/designers/{slug}` существуют, но листинга дизайнеров на витрине нет,
 * поэтому иначе робот нашёл бы их только по ссылкам из карточек товаров.
 * Пагинации у эндпоинта нет — дизайнеров единицы, приходят одним ответом.
 */
export async function getDesigners(locale?: string): Promise<FullDesignerDto[]> {
  const body = await apiGet<{ data: FullDesignerDto[] }>(
    withLocale('/designers', locale),
  );
  return body?.data ?? [];
}

/**
 * ВСЕ slug активных товаров — постранично, для карты сайта.
 *
 * Эндпоинт `/products` жёстко ограничивает `limit` сотней (Math.min(100, …) в
 * app/api/storefront/v1/products/route.ts), поэтому одним запросом каталог из ~850
 * позиций не забрать: без пагинации карта молча содержала бы первые 100 товаров.
 * Архивные сюда не попадают — API сам фильтрует `status: 'active'` (архивные дали
 * бы в карте 404, а их в этом магазине 748).
 *
 * `max` — общий потолок (карта всё равно обрежет по SITEMAP_PRODUCT_CAP); он же
 * страхует от бесконечного цикла, если сервер начнёт отдавать неверную пагинацию.
 * Локаль НЕ передаём: slug у товара один на все языки, а лишний параметр только
 * помешал бы кешированию ответа.
 */
export async function getAllProductSlugs(max = 15000): Promise<{ slug: string }[]> {
  const PAGE = 100; // потолок limit на стороне API
  const slugs: { slug: string }[] = [];
  for (let offset = 0; offset < max; offset += PAGE) {
    const res = await getProducts({ limit: PAGE, offset });
    for (const p of res.data) {
      if (p?.slug) slugs.push({ slug: p.slug });
    }
    // Последняя страница: сервер отдал меньше запрошенного либо total исчерпан.
    if (res.data.length < PAGE) break;
    if (res.pagination?.total && offset + PAGE >= res.pagination.total) break;
  }
  return slugs;
}

/**
 * Товары для «избранной» сетки главной: сперва featured, при пустом результате —
 * общий список (fallback), чтобы витрина всегда показывала реальные товары.
 */
export async function getHomeProducts(
  limit = 12,
  locale?: string,
): Promise<ProductListItemDto[]> {
  const featured = await getProducts({ featured: true, limit }, locale);
  if (featured.data.length > 0) {
    return featured.data;
  }
  const latest = await getProducts({ limit }, locale);
  return latest.data;
}

/**
 * Товары блока «Новинки» главной (carre `.mainpage--new`): сперва помеченные
 * `is_new` (?new=1), при пустом результате — общий список (fallback), чтобы блок
 * всегда показывал реальные товары, даже если магазин не проставил флаг новинки.
 */
export async function getNewProducts(
  limit = 12,
  locale?: string,
): Promise<ProductListItemDto[]> {
  const fresh = await getProducts({ isNew: true, limit }, locale);
  if (fresh.data.length > 0) {
    return fresh.data;
  }
  const latest = await getProducts({ limit }, locale);
  return latest.data;
}

// -----------------------------------------------------------------------------
// Чекаут (/cart/order): quote / создание заказа / инициация оплаты / СДЭК.
//
// В ОТЛИЧИЕ от apiGet (деградирует в null), эти методы БРОСАЮТ ApiError с кодом
// и сообщением из тела { error: { code, message } } — форма чекаута показывает
// покупателю понятное сообщение и различает out_of_stock/invalid_promo/…
// Вызываются из клиентских компонентов (браузер) — Origin ставит движок сам,
// buildHeaders на клиенте его не добавляет (см. выше).
// -----------------------------------------------------------------------------

/**
 * Ошибка Storefront API с машиночитаемым кодом (для веток UI чекаута).
 *
 * ДВА кода, не один (аудит №3/№6):
 *  • `code` — транспортный (conflict/unprocessable/not_found/network/…);
 *  • `reason` — доменная причина из публичного алфавита платформы, если сервер её
 *    прислал (out_of_stock, invalid_promo, invalid_gift, delivery_unavailable…).
 * UI выбирает подпись ПРИОРИТЕТНО по `reason`, транспортный код — фолбэк.
 * `message` — серверная диагностика (язык магазина): годится для консоли, но
 * НИКОГДА не показывается покупателю.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly status: number;
  constructor(status: number, err: StorefrontApiError) {
    super(err.message || 'Ошибка запроса.');
    this.name = 'ApiError';
    this.code = err.code || 'error';
    this.reason = err.reason || undefined;
    this.status = status;
  }
}

/** POST к Storefront API с { data } в ответе; бросает ApiError на !ok. */
async function apiPost<T>(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const url = `${apiBase()}/api/storefront/v1${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildHeaders(),
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiError(0, {
      code: 'network',
      message: `Сеть недоступна: ${(err as Error).message}`,
    });
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* пустое/невалидное тело — обработаем ниже по res.ok */
  }
  if (!res.ok) {
    const errBody = (parsed as { error?: StorefrontApiError } | null)?.error;
    throw new ApiError(res.status, errBody ?? { code: 'error', message: 'Ошибка запроса.' });
  }
  return (parsed as { data: T }).data;
}

/** GET к Storefront API с { data }; бросает ApiError на !ok (для чекаута). */
async function apiGetOrThrow<T>(path: string): Promise<T> {
  const url = `${apiBase()}/api/storefront/v1${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: buildHeaders(), cache: 'no-store' });
  } catch (err) {
    throw new ApiError(0, {
      code: 'network',
      message: `Сеть недоступна: ${(err as Error).message}`,
    });
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* пустое тело */
  }
  if (!res.ok) {
    const errBody = (parsed as { error?: StorefrontApiError } | null)?.error;
    throw new ApiError(res.status, errBody ?? { code: 'error', message: 'Ошибка запроса.' });
  }
  return (parsed as { data: T }).data;
}

/**
 * Серверный расчёт корзины (итог + доставка + промокод). Ничего не резервирует.
 * `locale` пробрасывается для локализованных подписей (напр. причины промокода),
 * не влияя на суммы (цены/эквайринг рублёвые — anti-tamper на сервере).
 */
export async function quoteCart(
  payload: CartQuoteRequest,
  locale?: string,
): Promise<QuoteDto> {
  return apiPost<QuoteDto>(withLocale('/cart/quote', locale), payload);
}

/**
 * Создание заказа. Idempotency-Key — в заголовке И в теле (заголовок приоритетен
 * на сервере). Повтор с тем же ключом не создаёт дубль (200 вместо 201).
 */
export async function createOrder(
  payload: CreateOrderRequest,
  idempotencyKey: string,
  locale?: string,
): Promise<OrderCreatedDto> {
  return apiPost<OrderCreatedDto>(
    withLocale('/orders', locale),
    { ...payload, idempotencyKey },
    { 'Idempotency-Key': idempotencyKey },
  );
}

/**
 * Подписка на рассылку из подвала витрины.
 *
 * 🔴 ПЕРЕИСПОЛЬЗУЕТ существующий публичный эндпоинт платформы
 * `POST /api/storefront/v1/newsletter` (app/api/storefront/v1/newsletter/route.ts,
 * G-12): тот же конвейер runStorefront (ключ/Origin → rate-limit → CORS), та же
 * валидация NewsletterInputSchema, та же идемпотентная запись в
 * `newsletter_subscribers`. Второго приёмника подписок НЕ создаём — иначе часть
 * адресов оседала бы мимо раздела «Подписчики» в админке.
 *
 * Адрес НЕ логируем ни здесь, ни на сервере (route пишет в лог только текст
 * ошибки БД) — персональные данные в логи не попадают.
 */
export async function subscribeNewsletter(email: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/newsletter', { email });
}

/**
 * Инициация онлайн-оплаты у АКТИВНОГО эквайера магазина. Сумма считается сервером
 * из заказа (anti-tamper). Доступ подтверждается токеном заказа (из createOrder).
 * Возвращает paymentUrl — редирект туда.
 *
 * 🔴 ВИТРИНА НЕ ЗНАЕТ ПРО ЭКВАЙЕРОВ. Путь нейтральный (`/payments/init`), эквайер
 * выбирает сервер по конфигу магазина. Раньше здесь был жёстко зашит путь
 * конкретного эквайера: при активном другом эквайере (дефолт —
 * `PAYMENTS_PROVIDER=tbank`) покупателя уводило на его mock-страницу, где
 * «оплата» проходила БЕЗ денег (аудит major №1).
 */
export async function initPayment(args: {
  orderNumber: string;
  accessToken: string;
  returnUrl?: string;
}): Promise<PaymentInitDto> {
  return apiPost<PaymentInitDto>('/payments/init', {
    orderNumber: args.orderNumber,
    accessToken: args.accessToken,
    ...(args.returnUrl ? { returnUrl: args.returnUrl } : {}),
  });
}

/**
 * Результат справочного запроса к СДЭК (города / ПВЗ).
 *
 * 🔴 Аудит major №19. Раньше обе функции были `catch { return []; }`, и сбой
 * транспорта/сервиса был НЕОТЛИЧИМ от честно пустого результата: витрина по
 * `length === 0` писала «в этом городе нет пунктов выдачи» (то есть врала про
 * СДЭК), а у автокомплита городов не показывала вообще ничего — покупатель не
 * понимал, что происходит. Теперь ошибку возвращаем ЯВНО:
 *   - `failed: false` — сервис ответил (список может быть честно пуст);
 *   - `failed: true`  — ответа по существу не было; писать «ничего не найдено» НЕЛЬЗЯ.
 * `reason` уточняет причину для подписи: `unavailable` — способ доставки сейчас
 * недоступен (модуль выключен / 404), `error` — временный сбой (сеть, 5xx).
 */
export interface CdekLookupResult<T> {
  items: T[];
  failed: boolean;
  reason?: 'unavailable' | 'error';
}

/** Разбор ошибки справочного запроса: недоступность способа vs временный сбой. */
function cdekLookupFailure<T>(err: unknown): CdekLookupResult<T> {
  // 404 (в т.ч. module_disabled) = у магазина этот способ доставки не работает;
  // всё остальное (сеть, 5xx, 4xx) — временный сбой, имеет смысл повторить.
  const unavailable = err instanceof ApiError && err.status === 404;
  // Диагностика — в консоль, покупателю показываем только строку словаря.
  console.warn('[storefront-api] cdek lookup failed:', err);
  return { items: [], failed: true, reason: unavailable ? 'unavailable' : 'error' };
}

/**
 * Поиск городов СДЭК для автокомплита (q ≥ 2 символов). Слишком короткий запрос —
 * НЕ сбой: `failed: false` с пустым списком (покупатель просто ещё не дописал).
 */
export async function cdekCities(
  q: string,
  limit = 10,
): Promise<CdekLookupResult<CdekCityDto>> {
  if (q.trim().length < 2) return { items: [], failed: false };
  const params = new URLSearchParams({ q: q.trim(), limit: String(limit) });
  try {
    const items = await apiGetOrThrow<CdekCityDto[]>(
      `/delivery/cdek/cities?${params.toString()}`,
    );
    return { items: items ?? [], failed: false };
  } catch (err) {
    return cdekLookupFailure<CdekCityDto>(err);
  }
}

/** Список ПВЗ/постаматов СДЭК в городе (по числовому коду города). */
export async function cdekPvz(
  cityCode: number,
  type?: 'PVZ' | 'POSTAMAT',
): Promise<CdekLookupResult<CdekPvzDto>> {
  const params = new URLSearchParams({ city_code: String(cityCode) });
  if (type) params.set('type', type);
  try {
    const items = await apiGetOrThrow<CdekPvzDto[]>(`/delivery/cdek/pvz?${params.toString()}`);
    return { items: items ?? [], failed: false };
  } catch (err) {
    return cdekLookupFailure<CdekPvzDto>(err);
  }
}

/**
 * Публичный статус заказа по номеру + токену доступа (страница успеха/трекинг).
 * `locale` → локализованные подписи статуса заказа/оплаты.
 */
export async function getOrder(
  number: string,
  accessToken: string,
  locale?: string,
): Promise<OrderPublicDto | null> {
  const params = new URLSearchParams({ token: accessToken });
  if (locale) params.set('locale', locale);
  try {
    return await apiGetOrThrow<OrderPublicDto>(
      `/orders/${encodeURIComponent(number)}?${params.toString()}`,
    );
  } catch {
    return null;
  }
}
