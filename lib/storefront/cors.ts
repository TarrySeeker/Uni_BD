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

/**
 * Строит CORS-заголовки ответа.
 *
 * @param origin разрешённый origin (из authorizeStorefront). Если задан —
 *   эхо-ответ Access-Control-Allow-Origin: <origin> + Vary: Origin. Если null/
 *   undefined (mock без Origin, либо запрос не из браузера) — отдаём «*»
 *   (без credentials, публичный read-каталог).
 */
export function buildCorsHeaders(
  origin?: string | null,
  methods: string = STOREFRONT_METHODS,
): Record<string, string> {
  const allowOrigin = origin && origin.trim() ? origin : '*';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': STOREFRONT_ALLOWED_HEADERS,
  };
  // При конкретном origin сообщаем кешам, что ответ зависит от Origin.
  if (allowOrigin !== '*') {
    headers.Vary = 'Origin';
  }
  return headers;
}

/** Заголовки именно для preflight-ответа (добавляет Max-Age к CORS). */
export function buildPreflightHeaders(
  origin?: string | null,
  methods: string = STOREFRONT_METHODS,
): Record<string, string> {
  return {
    ...buildCorsHeaders(origin, methods),
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
