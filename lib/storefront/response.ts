/**
 * Единый формат ответов/ошибок Storefront API + общий конвейер обработки роута
 * (docs/06 §6, ADR-008). Держим здесь, чтобы 4 роута не дублировали:
 *  authorizeStorefront → 401/403; isModuleEffectivelyEnabled('catalog') → 404;
 *  rate-limit по ключу/ip → 429; CORS-заголовки в каждом ответе; preflight.
 *
 * Формат успеха: { data, ...meta }.  Формат ошибки: { error: { code, message } }.
 */

import { NextResponse } from 'next/server';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import type { ModuleName } from '@/lib/config/modules';
import {
  checkStorefrontRate,
  registerStorefrontHit,
} from '@/lib/auth/rate-limit';
import { normalizeClientIp } from '@/lib/server/request-ip';
import { authorizeStorefront, extractApiKey } from './auth';
import type { AuthorizeResult } from './auth';
import {
  STOREFRONT_METHODS,
  buildCorsHeaders,
  buildPreflightHeaders,
  isPreflight,
} from './cors';

/** Код ошибки Storefront API. */
export type StorefrontErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'bad_request'
  | 'module_disabled'
  | 'conflict'
  | 'unprocessable';

const STATUS_BY_CODE: Record<StorefrontErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  bad_request: 400,
  module_disabled: 404,
  // 409 — конфликт остатков (нет товара под резерв, §6); 422 — невалидные
  // данные домена (позиция/промокод), синтаксис тела при этом валиден.
  conflict: 409,
  unprocessable: 422,
};

/** JSON-ответ успеха { data, ...meta } с CORS-заголовками. */
export function jsonData(
  data: unknown,
  meta: Record<string, unknown>,
  cors: Record<string, string>,
  init: { status?: number } = {},
): NextResponse {
  return NextResponse.json(
    { data, ...meta },
    { status: init.status ?? 200, headers: cors },
  );
}

/** JSON-ответ ошибки { error: { code, message } } с CORS-заголовками. */
export function jsonError(
  code: StorefrontErrorCode,
  message: string,
  cors: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status: STATUS_BY_CODE[code], headers: { ...cors, ...extraHeaders } },
  );
}

/** Контекст, переданный в обработчик после прохождения конвейера. */
export interface StorefrontContext {
  /** CORS-заголовки для ответа (origin уже разрешён). */
  cors: Record<string, string>;
  /** Нормализованный origin (если был). */
  origin?: string;
}

/**
 * Ключ ведра rate-limit витрины.
 *
 * SECURITY (волна 4, баг A): идентификатор ведра НЕЛЬЗЯ выводить из СЫРОГО
 * клиентского заголовка X-Api-Key/X-Storefront-Key. Прежде rateKey брал ЛЮБОЙ
 * непустой ключ как ведро (`storefront:key:<ключ>`) БЕЗ сверки с STOREFRONT_API_KEYS,
 * поэтому атакующий (авторизованный по разрешённому Origin) ротацией мусорного
 * X-Api-Key на каждый запрос получал СВЕЖЕЕ ведро (count=0) → лимит публичного
 * POST не срабатывал никогда. Поэтому:
 *   • ведро по ключу — ТОЛЬКО когда ключ ВАЛИДЕН (auth.via==='key', т.е. совпал с
 *     конфигом в authorizeStorefront); тогда extractApiKey даёт ровно тот ключ;
 *   • иначе (origin/mock/невалидный ключ) — ведро по ВАЛИДИРОВАННОМУ IP через
 *     normalizeClientIp (как auth/session/audit), мусорный X-Api-Key уже не влияет.
 *
 * `auth` уже вычислен в runStorefront ДО rateKey — просто прокидываем, чтобы не
 * дёргать authorizeStorefront дважды.
 */
function rateKey(req: Request, auth: AuthorizeResult): string {
  if (auth.via === 'key') {
    // Ключ совпал с конфигом — лимитируем по нему (стабильный идентификатор витрины).
    return `storefront:key:${extractApiKey(req.headers)}`;
  }
  // origin/mock/невалидный ключ → ведро по валидированному IP (формат проверен).
  const ip = normalizeClientIp(
    req.headers.get('x-forwarded-for'),
    req.headers.get('x-real-ip'),
  );
  return `storefront:ip:${ip ?? 'unknown'}`;
}

/** Опции конвейера: требуемый модуль и список CORS-методов роута. */
export interface StorefrontOptions {
  /**
   * Модуль, под которым работает роут (по умолчанию 'catalog'). Значение `null`
   * означает core-always-on роут (напр. /settings): проверка модуля пропускается,
   * роут доступен независимо от ADMIK_MODULES (auth/rate-limit сохраняются).
   */
  module?: ModuleName | null;
  /** CORS Access-Control-Allow-Methods (по умолчанию 'GET, OPTIONS'). */
  methods?: string;
}

/**
 * Обработка preflight OPTIONS — отдельная, без auth/rate-limit.
 * `methods` — какие методы рекламировать в CORS (POST для заказных роутов).
 */
export function handlePreflight(
  req: Request,
  methods: string = STOREFRONT_METHODS,
): NextResponse {
  const auth = authorizeStorefront(req.headers);
  if (isPreflight(req.method, req.headers)) {
    return new NextResponse(null, {
      status: 204,
      headers: buildPreflightHeaders(auth.ok ? auth.origin : null, methods),
    });
  }
  // Обычный OPTIONS без preflight-заголовков.
  return new NextResponse(null, {
    status: 204,
    headers: buildCorsHeaders(auth.ok ? auth.origin : null, methods),
  });
}

/**
 * Безопасно парсит JSON-тело запроса. Возвращает { ok:false } при невалидном
 * JSON — роут отдаёт 400 bad_request (не падает на пустом/битом теле).
 */
export async function parseJsonBody(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const text = await req.text();
    if (!text.trim()) {
      return { ok: true, value: {} };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Общий конвейер GET-роута Storefront API. Выполняет:
 *  1) модуль catalog включён? иначе 404;
 *  2) authorizeStorefront → 401 (нет ключа/origin) / 403 (неверные);
 *  3) rate-limit по ключу/ip → 429;
 * затем вызывает handler(ctx). Любые ошибки envelope'ятся как 500-нейтрально
 * вызывающим (handler сам решает 404 на отсутствие сущности).
 */
export async function runStorefront(
  req: Request,
  handler: (ctx: StorefrontContext) => Promise<NextResponse>,
  options: StorefrontOptions = {},
): Promise<NextResponse> {
  // module === null → core-always-on (без гейта по модулю); undefined → 'catalog'.
  const moduleName = options.module === null ? null : options.module ?? 'catalog';
  const methods = options.methods ?? STOREFRONT_METHODS;
  const auth = authorizeStorefront(req.headers);
  const cors = buildCorsHeaders(auth.ok ? auth.origin : null, methods);

  // 1) Требуемый модуль (catalog для каталога, orders для заказов, §4.2).
  //    Для core-always-on (moduleName === null) проверка пропускается.
  //    Авторитетный гейт (env ⊕ БД-оверрайд): выключение модуля из UI → 404.
  if (moduleName !== null && !(await isModuleEffectivelyEnabled(moduleName))) {
    return jsonError(
      'module_disabled',
      `Модуль «${moduleName}» отключён.`,
      cors,
    );
  }

  // 2) Аутентификация витрины.
  if (!auth.ok) {
    // Различаем «не предъявлено» (401) и «предъявлено, но неверно» (403).
    const presented =
      extractApiKey(req.headers) !== null || req.headers.get('origin') !== null;
    if (presented) {
      return jsonError('forbidden', 'Доступ витрины запрещён.', cors);
    }
    return jsonError(
      'unauthorized',
      'Требуется API-ключ витрины или разрешённый Origin.',
      cors,
    );
  }

  // 3) Rate-limit — ОТДЕЛЬНЫЙ щедрый лимит витрины (НЕ порог логина 10/15мин,
  //    иначе серверная витрина под одним ключом мгновенно ловит 429 и каталог
  //    на сайте пустеет). См. STOREFRONT_RATE_LIMIT.
  const key = rateKey(req, auth);
  const rate = await checkStorefrontRate(key);
  if (!rate.allowed) {
    return jsonError('rate_limited', 'Слишком много запросов.', cors, {
      'Retry-After': String(rate.retryAfterSec ?? 60),
    });
  }
  // Каждый запрос — +1 к счётчику окна (fixed-window лимит на витрину/ip).
  await registerStorefrontHit(key);

  return handler({ cors, origin: auth.ok ? auth.origin : undefined });
}
