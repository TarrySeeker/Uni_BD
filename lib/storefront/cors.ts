/**
 * CORS для Storefront API (docs/06 §6, ADR-008).
 *
 * Витрины — внешние SPA на других доменах (Netlify), поэтому браузер шлёт
 * cross-origin запросы и preflight (OPTIONS). Здесь — чистые функции построения
 * CORS-заголовков и распознавания preflight. Логика «какой origin разрешён»
 * берётся из authorizeStorefront (auth.ts) — сюда передаётся уже разрешённый
 * origin (или его отсутствие).
 */

/** Методы, которые отдаёт публичный read-каталог. */
export const STOREFRONT_METHODS = 'GET, OPTIONS';

/** Методы заказных эндпоинтов витрины (quote/создание — POST). */
export const STOREFRONT_WRITE_METHODS = 'GET, POST, OPTIONS';

/**
 * Заголовки запроса, которые витрина вправе слать. Idempotency-Key —
 * анти-дубль при создании заказа (POST /orders, docs/07 §4.2).
 */
export const STOREFRONT_ALLOWED_HEADERS =
  'Content-Type, X-Storefront-Key, X-Api-Key, Idempotency-Key';

/** Сколько секунд браузер может кешировать preflight-ответ. */
export const STOREFRONT_PREFLIGHT_MAX_AGE = 600;

/** Опции построения CORS-заголовков. */
export interface CorsOptions {
  /** Access-Control-Allow-Methods (по умолчанию STOREFRONT_METHODS). */
  methods?: string;
  /**
   * Разрешать ли Access-Control-Allow-Credentials:true при конкретном origin.
   *
   * По умолчанию true — публичные read-роуты отдают credentials, чтобы
   * navigator.sendBeacon (credentials:include) не резался браузером; данные там
   * публичны, cookie-авторизации нет. Для credentialed account/*-роутов вызывающий
   * ПЕРЕДАЁТ false, если origin не сконфигурирован явно (originAllowed=false):
   * тогда сторонний сайт не сможет прочитать ответ авторизованного покупателя
   * (7a security-medium). Спека CORS всё равно запрещает «*»+credentials, поэтому
   * при origin='*' флаг не ставится независимо от этой опции.
   */
  credentials?: boolean;
}

/**
 * Строит CORS-заголовки ответа.
 *
 * @param origin разрешённый origin (из authorizeStorefront). Если задан —
 *   эхо-ответ Access-Control-Allow-Origin: <origin> + Vary: Origin. Если null/
 *   undefined (mock без Origin, либо запрос не из браузера) — отдаём «*»
 *   (без credentials, публичный read-каталог).
 * @param opts methods + флаг credentials (см. CorsOptions).
 */
export function buildCorsHeaders(
  origin?: string | null,
  opts: CorsOptions = {},
): Record<string, string> {
  const methods = opts.methods ?? STOREFRONT_METHODS;
  const credentials = opts.credentials ?? true;
  const allowOrigin = origin && origin.trim() ? origin : '*';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': STOREFRONT_ALLOWED_HEADERS,
  };
  // При конкретном origin сообщаем кешам, что ответ зависит от Origin. Спека CORS
  // запрещает пару «*»+credentials, поэтому при «*» флаг НЕ ставим. При конкретном
  // origin флаг ставим, только если вызывающий это разрешил (credentials !== false):
  // публичные роуты — да (beacon), account/* — лишь для доверенного origin.
  if (allowOrigin !== '*') {
    headers.Vary = 'Origin';
    if (credentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }
  return headers;
}

/** Заголовки именно для preflight-ответа (добавляет Max-Age к CORS). */
export function buildPreflightHeaders(
  origin?: string | null,
  opts: CorsOptions = {},
): Record<string, string> {
  return {
    ...buildCorsHeaders(origin, opts),
    'Access-Control-Max-Age': String(STOREFRONT_PREFLIGHT_MAX_AGE),
  };
}

/** true, если это preflight-запрос (OPTIONS + Access-Control-Request-Method). */
export function isPreflight(method: string, headers: {
  get(name: string): string | null;
}): boolean {
  return (
    method.toUpperCase() === 'OPTIONS' &&
    headers.get('access-control-request-method') !== null
  );
}
