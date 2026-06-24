/**
 * Низкоуровневый HTTP-клиент СДЭК API v2 (docs/08 §2.2 «CdekClient», порт
 * carre Client::request/doRequest).
 *
 * Зона ответственности — транспорт: один аутентифицированный запрос к СДЭК.
 *   • Базовый URL берётся из конфигурации (CdekConfig.baseUrl).
 *   • Authorization: Bearer <token> — токен из token-cache (getToken()).
 *   • Сериализация query/json, дефолтные заголовки (Accept: application/json).
 *   • Таймаут на запрос (AbortController).
 *   • Ретрай на сетевые ошибки и 5xx — до maxNetworkRetries (250/500мс).
 *   • Ретрай на 401 — invalidate() токена + ровно один повтор со свежим токеном.
 *   • HTTP ≥ 400 → CdekError(code, message, { cdekErrors, httpStatus }).
 *
 * АРХИТЕКТУРНОЕ РЕШЕНИЕ (выбор mock vs real для пакета C).
 *
 * CdekClient — ВСЕГДА реальный (ходит в сеть). Mock-данные живут отдельно в
 * lib/cdek/mock/* и НЕ проходят через client. Сервисы пакета C выбирают источник
 * сами по флагу: `getCdekManager().isMock` (или isCdekMock()/getCdekConfig().
 * account). При isMock — берут детерминированные mock-функции; иначе — client.
 *
 * Почему так (а не «mock-клиент с тем же интерфейсом»): mock-ответы СДЭК
 * структурно проще доменных результатов сервисов (тариф/ПВЗ/uuid), а сервисы и
 * так разветвляются на mock-формулу/фикстуры. Отдельный mock-слой избавляет
 * client от веток «если mock» в каждом методе и держит транспорт чистым. В
 * mock-режиме client просто не инстанцируется (manager.client кидает ошибку при
 * обращении в mock — это баг вызывающего, а не штатный путь). См. manager.ts.
 */

import type { CdekConfig } from './config';
import { CdekError, type CdekApiError } from './errors';
import {
  createTokenCache,
  getDefaultTokenStore,
  type TokenCache,
  type TokenStore,
} from './token-cache';

/** HTTP-методы, используемые против СДЭК API. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Опции одного запроса (порт options из carre Client::request). */
export interface RequestOptions {
  /** Query-параметры (undefined-значения отбрасываются). */
  query?: Record<string, string | number | boolean | undefined>;
  /** Тело JSON (сериализуется, ставит Content-Type: application/json). */
  json?: unknown;
  /** Таймаут запроса, мс (дефолт 30000). */
  timeoutMs?: number;
  /** Сетевых ретраев (дефолт 2; задержки 250/500мс). */
  maxNetworkRetries?: number;
}

/** Публичный интерфейс клиента (порт ICdekClient, docs/08 §2.2). */
export interface ICdekClient {
  request<T = unknown>(method: HttpMethod, path: string, opts?: RequestOptions): Promise<T>;
  getToken(): Promise<string>;
  invalidateToken(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_NETWORK_RETRIES = 2;
/** Задержки между сетевыми ретраями (мс), по индексу попытки. */
const RETRY_DELAYS_MS = [250, 500] as const;

/** Параметры конструктора клиента. */
export interface CdekClientOptions {
  config: CdekConfig;
  /** Кеш токена. По умолчанию строится из config + дефолтного store. */
  tokenCache?: TokenCache;
  /** Хранилище токена (если tokenCache не передан). */
  tokenStore?: TokenStore;
  /** fetch для тестов (vi.fn). По умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Признак сетевой ошибки fetch (включая abort по таймауту). */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === 'AbortError');
}

/**
 * Реальный HTTP-клиент СДЭК. Ходит в сеть через fetch; в mock-режиме НЕ
 * используется (см. шапку и manager.ts).
 */
export class CdekClient implements ICdekClient {
  private readonly baseUrl: string;
  private readonly tokenCache: TokenCache;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CdekClientOptions) {
    const { config } = opts;
    if (!config.account || !config.secret) {
      throw new CdekError(
        'cdek_client_no_credentials',
        'CdekClient требует CDEK_ACCOUNT/CDEK_SECRET (в mock-режиме клиент не используется).',
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;

    if (opts.tokenCache) {
      this.tokenCache = opts.tokenCache;
    } else {
      // Хранилище: переданное или дефолтное (Redis|память). Строим лениво через
      // обёртку, чтобы не разрешать промис в конструкторе.
      const lazyStore = opts.tokenStore
        ? Promise.resolve(opts.tokenStore)
        : getDefaultTokenStore();
      let realCache: TokenCache | null = null;
      const ensure = async (): Promise<TokenCache> => {
        if (!realCache) {
          const store = await lazyStore;
          realCache = createTokenCache({
            baseUrl: this.baseUrl,
            account: config.account!,
            secret: config.secret!,
            store,
            fetchImpl: this.fetchImpl,
          });
        }
        return realCache;
      };
      this.tokenCache = {
        getToken: () => ensure().then((c) => c.getToken()),
        invalidate: () => ensure().then((c) => c.invalidate()),
      };
    }
  }

  getToken(): Promise<string> {
    return this.tokenCache.getToken();
  }

  invalidateToken(): Promise<void> {
    return this.tokenCache.invalidate();
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const token = await this.getToken();
    return this.doRequest<T>(method, path, opts, token, 0);
  }

  private async doRequest<T>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions,
    token: string,
    attempt: number,
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const maxRetries = opts.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (opts.json !== undefined && (method === 'POST' || method === 'PATCH')) {
      body = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      // Сетевая ошибка/таймаут — ретрай до maxRetries.
      if (isNetworkError(err) && attempt < maxRetries) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
        return this.doRequest<T>(method, path, opts, token, attempt + 1);
      }
      throw new CdekError(
        'cdek_network_error',
        `CDEK network error on ${method} ${path}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // 401 — сбросить токен и повторить ровно один раз со свежим.
    if (res.status === 401 && attempt === 0) {
      await this.invalidateToken();
      const fresh = await this.getToken();
      return this.doRequest<T>(method, path, opts, fresh, 1);
    }

    // 5xx — ретрай как сетевую ошибку (до maxRetries).
    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      return this.doRequest<T>(method, path, opts, token, attempt + 1);
    }

    const text = await res.text();
    let decoded: unknown = {};
    if (text) {
      try {
        decoded = JSON.parse(text);
      } catch {
        if (res.status >= 400) {
          throw new CdekError(
            'cdek_http_error',
            `CDEK HTTP ${res.status} on ${method} ${path}`,
            { httpStatus: res.status },
          );
        }
        throw new CdekError(
          'cdek_invalid_json',
          `CDEK invalid JSON on ${method} ${path}: ${text.slice(0, 500)}`,
          { httpStatus: res.status },
        );
      }
    }

    if (res.status >= 400) {
      throw new CdekError(
        'cdek_http_error',
        `CDEK HTTP ${res.status} on ${method} ${path}`,
        { httpStatus: res.status, cdekErrors: extractCdekErrors(decoded) },
      );
    }

    return decoded as T;
  }
}

/** Достаёт structured errors[] из тела ответа СДЭК (поле `errors`). */
function extractCdekErrors(decoded: unknown): CdekApiError[] {
  if (
    decoded &&
    typeof decoded === 'object' &&
    'errors' in decoded &&
    Array.isArray((decoded as { errors: unknown }).errors)
  ) {
    const raw = (decoded as { errors: unknown[] }).errors;
    return raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({
        code: typeof e.code === 'string' ? e.code : 'unknown',
        message: typeof e.message === 'string' ? e.message : '',
      }));
  }
  return [];
}
