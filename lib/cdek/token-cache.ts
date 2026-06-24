/**
 * Кеш OAuth-токена СДЭК (docs/08 §2.3 «token-cache.ts», §4 «OAuth и кеш токена»;
 * порт Client::getToken/invalidateToken из carre).
 *
 * Грант — client_credentials: `POST {baseUrl}/v2/oauth/token`,
 * `application/x-www-form-urlencoded`, тело
 * `grant_type=client_credentials&client_id=…&client_secret=…`. Ответ содержит
 * `access_token` и `expires_in` (сек). Кешируется *строка токена* (не весь
 * ответ), TTL = `expires_in − 60` (минимум 60с, дефолт-фоллбэк 3540с).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ОБОСНОВАНИЕ ХРАНИЛИЩА (требование задачи).
 *
 * Зеркалит паттерн lib/auth/rate-limit.ts: абстракция TokenStore с двумя
 * реализациями — MemoryTokenStore (Map с абсолютным TTL, дефолт) и
 * RedisTokenStore (ioredis `SET key val EX ttl`, при наличии REDIS_URL). По
 * умолчанию выбираем ПАМЯТЬ процесса (а не Redis), и вот почему:
 *
 *   • Токен короткоживущий (~1 час) и дешёвый в повторной добыче — один POST.
 *   • Per-instance кеш достаточен: на нескольких инстансах допускается редкая
 *     гонка на холодном старте — СДЭК выдаст оба токена валидными (разные jti),
 *     второй перезапишет кеш; критичности нет (docs/08 §4, carre 14 §1).
 *   • Память проще: не открывает соединение, не тянет драйвер в mock-режиме,
 *     нет внешней зависимости в горячем пути авторизации каждого запроса.
 *
 * Redis оставлен как опция (масштаб между инстансами), но не является дефолтом —
 * память «проще и достаточно». Single-flight (см. ниже) живёт на процессе в
 * любом случае и снимает локальную конкуренцию.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * SINGLE-FLIGHT: при промахе кеша добыча токена идёт через один in-flight
 * Promise на процесс (на ключ), чтобы параллельные вызовы не дёргали
 * `/oauth/token` одновременно.
 *
 * RETRY 401: бизнес-клиент (client.ts) при 401 зовёт invalidate() и повторяет
 * один раз — сброс кеша гарантирует, что следующий get() добудет свежий токен.
 *
 * MOCK: в mock-режиме (isCdekMock) get() возвращает фейковый 'mock-token' без
 * сети — см. createMockTokenCache().
 */

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getEnv } from '@/lib/config/env';
import { CdekError } from './errors';

/** Фейковый токен mock-режима (docs/08 §11: getToken() → 'mock-token'). */
export const CDEK_MOCK_TOKEN = 'mock-token';

/** Минимальный TTL токена в кеше (с), нижняя граница expires_in−60. */
const MIN_TOKEN_TTL_SEC = 60;
/** Фоллбэк TTL, если СДЭК не вернул expires_in (carre: 3540с). */
const FALLBACK_TOKEN_TTL_SEC = 3540;
/** Запас, вычитаемый из expires_in (минута на сетевой джиттер). */
const TTL_SAFETY_MARGIN_SEC = 60;

/** Таймаут добычи токена по умолчанию (мс). */
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Хранилище токена (TokenStore) — как RateBackend в rate-limit.ts.
// ---------------------------------------------------------------------------

/** Низкоуровневое хранилище строки токена с TTL. */
export interface TokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface MemEntry {
  value: string;
  /** Абсолютное время истечения (ms, как Date.now()). */
  expiresAt: number;
}

/**
 * In-memory реализация на Map. Дефолтное хранилище (см. обоснование в шапке).
 * Не масштабируется между процессами — это сознательный выбор для короткоживущего
 * токена.
 */
export class MemoryTokenStore implements TokenStore {
  private readonly store = new Map<string, MemEntry>();
  /** Сдвиг «виртуального времени» для тестов истечения TTL. */
  private clockSkewMs = 0;

  private now(): number {
    return Date.now() + this.clockSkewMs;
  }

  /** Только для тестов: сдвинуть внутренние часы вперёд на N мс. */
  __advance(ms: number): void {
    this.clockSkewMs += ms;
  }

  private live(key: string): MemEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSec * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * Redis-реализация (`SET key val EX ttl`). Опциональна (см. обоснование);
 * вживую в CI не тестируется (Redis нет), интерфейс идентичен MemoryTokenStore.
 */
export class RedisTokenStore implements TokenStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.redis.set(key, value, 'EX', Math.max(1, ttlSec));
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

// ---------------------------------------------------------------------------
// Расчёт TTL и ключа.
// ---------------------------------------------------------------------------

/** TTL токена из expires_in: (expires_in − 60), min 60, фоллбэк 3540 (carre). */
export function tokenTtlFromExpiresIn(expiresIn: number | undefined): number {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return FALLBACK_TOKEN_TTL_SEC;
  }
  const ttl = Math.floor(expiresIn) - TTL_SAFETY_MARGIN_SEC;
  return ttl < MIN_TOKEN_TTL_SEC ? MIN_TOKEN_TTL_SEC : ttl;
}

/** Ключ кеша токена: cdek:oauth:token:<sha256(account)> (docs/08 §2.3). */
export function tokenCacheKey(account: string): string {
  const hash = createHash('sha256').update(account).digest('hex');
  return `cdek:oauth:token:${hash}`;
}

// ---------------------------------------------------------------------------
// Ответ OAuth и добыча токена.
// ---------------------------------------------------------------------------

/** Сырой ответ `/v2/oauth/token`. */
export interface OAuthTokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

/** Параметры реального кеша токена. */
export interface TokenCacheOptions {
  baseUrl: string;
  account: string;
  secret: string;
  store: TokenStore;
  /**
   * Низкоуровневый fetch (для тестов подменяется на vi.fn). По умолчанию —
   * глобальный fetch. Тип совместим с globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Публичный интерфейс кеша токена. */
export interface TokenCache {
  /** Валидный токен из кеша или свежедобытый (single-flight на промахе). */
  getToken(): Promise<string>;
  /** Сброс кеша (вызывается клиентом при 401 перед повтором). */
  invalidate(): Promise<void>;
}

/**
 * Реальный кеш токена: store + single-flight + retry-friendly invalidate.
 *
 * Single-flight: in-flight Promise на процесс. Параллельные getToken() при
 * промахе ждут один и тот же fetchToken() и не порождают вторую авторизацию.
 */
export function createTokenCache(opts: TokenCacheOptions): TokenCache {
  const { baseUrl, account, secret, store } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TOKEN_FETCH_TIMEOUT_MS;
  const key = tokenCacheKey(account);

  /** Активная добыча токена (single-flight). */
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<OAuthTokenResponse> {
    const url = `${baseUrl.replace(/\/$/, '')}/v2/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: account,
      client_secret: secret,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      throw new CdekError(
        'cdek_token_network_error',
        `CDEK token fetch network error: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let decoded: Partial<OAuthTokenResponse> & { errors?: unknown } = {};
    const text = await res.text();
    if (text) {
      try {
        decoded = JSON.parse(text) as typeof decoded;
      } catch {
        throw new CdekError(
          'cdek_token_invalid_json',
          `CDEK token fetch invalid JSON: ${text.slice(0, 500)}`,
          { httpStatus: res.status },
        );
      }
    }

    if (res.status >= 400 || !decoded.access_token) {
      throw new CdekError(
        'cdek_token_fetch_failed',
        `CDEK token fetch failed HTTP ${res.status}`,
        { httpStatus: res.status },
      );
    }

    return decoded as OAuthTokenResponse;
  }

  async function obtain(): Promise<string> {
    const data = await fetchToken();
    const ttl = tokenTtlFromExpiresIn(data.expires_in);
    await store.set(key, data.access_token, ttl);
    return data.access_token;
  }

  return {
    async getToken(): Promise<string> {
      const cached = await store.get(key);
      if (cached) return cached;

      // single-flight: один обходчик /oauth/token на процесс.
      if (inFlight) return inFlight;
      inFlight = obtain().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    async invalidate(): Promise<void> {
      await store.del(key);
    },
  };
}

/** Mock-кеш токена: всегда отдаёт 'mock-token', без сети (docs/08 §11). */
export function createMockTokenCache(): TokenCache {
  return {
    async getToken(): Promise<string> {
      return CDEK_MOCK_TOKEN;
    },
    async invalidate(): Promise<void> {
      /* no-op */
    },
  };
}

// ---------------------------------------------------------------------------
// Дефолтное хранилище (Redis при REDIS_URL, иначе память) — как getDefaultLimiter.
// ---------------------------------------------------------------------------

let mockWarned = false;

function warnMemoryOnce(): void {
  if (!mockWarned) {
    mockWarned = true;
    console.warn(
      '[cdek] кеш OAuth-токена в памяти процесса (REDIS_URL не задан). ' +
        'Токен короткоживущий, per-instance кеш достаточен (docs/08 §4).',
    );
  }
}

let defaultStore: Promise<TokenStore> | undefined;

/**
 * Лениво строит дефолтное хранилище токена: Redis при REDIS_URL, иначе память
 * (с одноразовым warn). Ленивость + динамический import('ioredis') — чтобы
 * импорт модуля не открывал соединение и mock-режим не тянул драйвер.
 */
export function getDefaultTokenStore(): Promise<TokenStore> {
  if (defaultStore) return defaultStore;

  defaultStore = (async (): Promise<TokenStore> => {
    const { REDIS_URL } = getEnv();
    if (REDIS_URL) {
      const { default: IORedis } = await import('ioredis');
      const redis = new IORedis(REDIS_URL, { lazyConnect: true });
      return new RedisTokenStore(redis);
    }
    warnMemoryOnce();
    return new MemoryTokenStore();
  })();

  return defaultStore;
}

/** Сбрасывает кешированное дефолтное хранилище (используется в тестах). */
export function resetDefaultTokenStore(): void {
  defaultStore = undefined;
  mockWarned = false;
}
