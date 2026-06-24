import type { Redis } from 'ioredis';
import { getEnv } from '@/lib/config/env';

/**
 * Rate-limit на логин (см. docs/04 §4.5).
 *
 * Стратегия — fixed window: на ключ (login:fail:{ip} / login:fail:{email})
 * считаем неудачные попытки; при достижении порога в пределах окна логин
 * временно блокируется. Бэкенд по умолчанию — Redis (масштабируется между
 * инстансами, ADR-002). Если REDIS_URL не задан (demo-магазин без Redis) —
 * безопасный fallback на in-memory Map с одноразовым warn (требование
 * mock-режима зависимостей, docs/02).
 *
 * Выбор бэкенда вынесен в фабрику createRateLimiter({ backend }), чтобы его
 * можно было тестировать без живого Redis (см. tests/auth/rate-limit.test.ts).
 */

/** Порог и окно блокировки. */
export const RATE_LIMIT = {
  /** Сколько неудач допустимо в окне до блокировки. */
  maxAttempts: 10,
  /** Длина окна в секундах (15 минут). */
  windowSec: 15 * 60,
} as const;

export interface RateCheckResult {
  allowed: boolean;
  retryAfterSec?: number;
}

/**
 * Низкоуровневый бэкенд хранения счётчиков. Возвращает текущее значение
 * счётчика и оставшийся TTL окна (в секундах), чтобы лимитер мог посчитать
 * retryAfterSec без знания деталей хранилища.
 */
export interface RateBackend {
  /** Текущее число неудач и TTL окна для ключа. */
  get(key: string): Promise<{ count: number; ttlSec: number }>;
  /** Атомарно +1 к счётчику; при первой неудаче ставит TTL окна. */
  increment(key: string, windowSec: number): Promise<void>;
  /** Полностью очищает ключ (вызывается при успешном логине). */
  reset(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory бэкенд (mock-режим и юнит-тесты)
// ---------------------------------------------------------------------------

interface MemEntry {
  count: number;
  /** Абсолютное время истечения окна (ms, как Date.now()). */
  expiresAt: number;
}

/**
 * Верхний предел числа ключей в MemoryRateBackend.
 *
 * Защита от роста памяти/OOM в mock-режиме (без Redis): на storefront-пути ключ
 * ведра = по IP, reset не вызывается, а истёкшая запись чистится лишь при
 * повторном обращении к ТОМУ ЖЕ ключу. Атакующий ротацией X-Forwarded-For
 * (валидные IP) вставляет лавину никогда-не-перечитываемых записей → Map растёт
 * без границы. Прод с Redis не затронут (EXPIRE сам чистит ключи).
 *
 * При достижении предела сначала вычищаются истёкшие записи (по window-expiry),
 * затем — если всё ещё переполнено — вытесняются НАИМЕНЕЕ опасные активные
 * записи (с наименьшим count): флуд создаёт записи count=1, тогда как ключи у
 * порога блокировки (count→maxAttempts) — именно то, что важно удержать. Так
 * вытеснение не «амнистирует» реально лимитируемые ключи (жертву brute-force).
 */
export const MEMORY_RATE_MAX_ENTRIES = 10_000;

/**
 * In-memory реализация на Map. Не масштабируется между процессами — годится
 * только для demo/mock-режима и тестов. Размер Map ограничен сверху
 * (MEMORY_RATE_MAX_ENTRIES) с ленивой очисткой истёкших и вытеснением, чтобы
 * mock-режим нельзя было довести до OOM ротацией ключей.
 */
export class MemoryRateBackend implements RateBackend {
  private readonly store = new Map<string, MemEntry>();
  /** Сдвиг «виртуального времени» для тестов истечения окна. */
  private clockSkewMs = 0;
  /** Предел размера Map (для тестов — конструктором). */
  private readonly maxEntries: number;

  constructor(maxEntries: number = MEMORY_RATE_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  private now(): number {
    return Date.now() + this.clockSkewMs;
  }

  /** Только для тестов: сдвинуть внутренние часы вперёд на N мс. */
  __advance(ms: number): void {
    this.clockSkewMs += ms;
  }

  /** Только для тестов: текущее число хранимых ключей. */
  __size(): number {
    return this.store.size;
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

  /** Удаляет все истёкшие записи (ленивая очистка по window-expiry). */
  private purgeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  /**
   * Гарантирует место под новую запись: сперва чистит истёкшие, затем — если
   * Map всё ещё на пределе — вытесняет наименее опасные активные записи (с
   * наименьшим count). Так флуд (count=1) уступает место, а ключи у порога
   * блокировки удерживаются (счётчик жертвы brute-force не сбрасывается).
   */
  private ensureCapacity(): void {
    if (this.store.size < this.maxEntries) return;
    this.purgeExpired();
    if (this.store.size < this.maxEntries) return;
    // Освобождаем минимум 1 слот: вытесняем запись с минимальным count.
    // Map итерируется в порядке вставки → при равном count выселяется самая
    // старая (FIFO-tie-break), что соответствует «наименее свежей».
    while (this.store.size >= this.maxEntries) {
      let victimKey: string | undefined;
      let victimCount = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.store) {
        if (entry.count < victimCount) {
          victimCount = entry.count;
          victimKey = key;
        }
      }
      if (victimKey === undefined) break;
      this.store.delete(victimKey);
    }
  }

  async get(key: string): Promise<{ count: number; ttlSec: number }> {
    const entry = this.live(key);
    if (!entry) return { count: 0, ttlSec: 0 };
    const ttlSec = Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000));
    return { count: entry.count, ttlSec };
  }

  async increment(key: string, windowSec: number): Promise<void> {
    const entry = this.live(key);
    if (entry) {
      entry.count += 1;
    } else {
      // Перед вставкой НОВОГО ключа — ограничиваем рост Map.
      this.ensureCapacity();
      this.store.set(key, {
        count: 1,
        expiresAt: this.now() + windowSec * 1000,
      });
    }
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Redis бэкенд
// ---------------------------------------------------------------------------

/**
 * Redis-реализация fixed-window через INCR + EXPIRE.
 *
 * При первом INCR (значение становится 1) выставляем EXPIRE на окно, что
 * автоматически очищает счётчик по истечении. TTL читаем через PTTL/TTL для
 * подсчёта retryAfterSec. Redis-путь вживую не тестируется (Redis нет в CI),
 * но интерфейс идентичен MemoryRateBackend.
 */
export class RedisRateBackend implements RateBackend {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<{ count: number; ttlSec: number }> {
    const [raw, ttl] = await Promise.all([
      this.redis.get(key),
      this.redis.ttl(key),
    ]);
    const count = raw ? Number.parseInt(raw, 10) || 0 : 0;
    // ttl == -1 (нет TTL) или -2 (нет ключа) → окно неактивно.
    const ttlSec = ttl > 0 ? ttl : 0;
    return { count, ttlSec };
  }

  async increment(key: string, windowSec: number): Promise<void> {
    const next = await this.redis.incr(key);
    if (next === 1) {
      await this.redis.expire(key, windowSec);
    }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

// ---------------------------------------------------------------------------
// Лимитер поверх бэкенда
// ---------------------------------------------------------------------------

export interface RateLimiter {
  checkLoginRate(key: string): Promise<RateCheckResult>;
  registerLoginFailure(key: string): Promise<void>;
  resetLoginFailures(key: string): Promise<void>;
}

export interface RateLimiterOptions {
  backend: RateBackend;
  maxAttempts?: number;
  windowSec?: number;
}

/**
 * Фабрика лимитера. Инкапсулирует бизнес-правила (порог/окно/retryAfter) и
 * делегирует хранение в RateBackend. Тестируется с MemoryRateBackend.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const backend = opts.backend;
  const maxAttempts = opts.maxAttempts ?? RATE_LIMIT.maxAttempts;
  const windowSec = opts.windowSec ?? RATE_LIMIT.windowSec;

  return {
    async checkLoginRate(key: string): Promise<RateCheckResult> {
      const { count, ttlSec } = await backend.get(key);
      if (count >= maxAttempts) {
        // Если TTL по какой-то причине неизвестен — отдаём полное окно.
        return { allowed: false, retryAfterSec: ttlSec > 0 ? ttlSec : windowSec };
      }
      return { allowed: true };
    },

    async registerLoginFailure(key: string): Promise<void> {
      await backend.increment(key, windowSec);
    },

    async resetLoginFailures(key: string): Promise<void> {
      await backend.reset(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Дефолтный инстанс + тонкие обёртки (прод-API)
// ---------------------------------------------------------------------------

let mockWarned = false;

function warnMockOnce(): void {
  if (!mockWarned) {
    mockWarned = true;
    console.warn(
      '[admik] rate-limit в mock-режиме, Redis не настроен (REDIS_URL пуст). ' +
        'Счётчики хранятся в памяти процесса и не масштабируются между инстансами.',
    );
  }
}

let defaultLimiter: Promise<RateLimiter> | undefined;

/**
 * Лениво строит дефолтный лимитер: Redis при наличии REDIS_URL, иначе
 * in-memory mock (с одноразовым warn). Ленивость + динамический import('ioredis')
 * нужны, чтобы импорт модуля не открывал соединение с Redis и mock-режим не
 * тянул драйвер (и чтобы код оставался ESM-совместимым, без require()).
 */
function getDefaultLimiter(): Promise<RateLimiter> {
  if (defaultLimiter) return defaultLimiter;

  defaultLimiter = (async (): Promise<RateLimiter> => {
    const { REDIS_URL } = getEnv();
    if (REDIS_URL) {
      const { default: IORedis } = await import('ioredis');
      const redis = new IORedis(REDIS_URL, { lazyConnect: true });
      return createRateLimiter({ backend: new RedisRateBackend(redis) });
    }
    warnMockOnce();
    return createRateLimiter({ backend: new MemoryRateBackend() });
  })();

  return defaultLimiter;
}

/** Сбрасывает кешированный дефолтный лимитер (используется в тестах). */
export function resetDefaultLimiter(): void {
  defaultLimiter = undefined;
  storefrontLimiter = undefined;
  mockWarned = false;
}

export async function checkLoginRate(key: string): Promise<RateCheckResult> {
  return (await getDefaultLimiter()).checkLoginRate(key);
}

export async function registerLoginFailure(key: string): Promise<void> {
  return (await getDefaultLimiter()).registerLoginFailure(key);
}

// ---------------------------------------------------------------------------
// Storefront API rate-limit — ОТДЕЛЬНЫЙ, щедрый лимит.
// ---------------------------------------------------------------------------
// Публичный read-API витрины НЕЛЬЗЯ ограничивать порогом логина (10/15мин):
// серверная витрина (SSR) делает по 2+ запроса на каждую страницу под ОДНИМ
// ключом → мгновенно ловит 429, и каталог на сайте становится пустым. Здесь —
// высокий порог в коротком окне (защита от явного абуза, но не мешает витрине).
export const STOREFRONT_RATE_LIMIT = {
  maxAttempts: 600,
  windowSec: 60,
} as const;

let storefrontLimiter: Promise<RateLimiter> | undefined;

function getStorefrontLimiter(): Promise<RateLimiter> {
  if (storefrontLimiter) return storefrontLimiter;
  storefrontLimiter = (async (): Promise<RateLimiter> => {
    const opts = {
      maxAttempts: STOREFRONT_RATE_LIMIT.maxAttempts,
      windowSec: STOREFRONT_RATE_LIMIT.windowSec,
    };
    const { REDIS_URL } = getEnv();
    if (REDIS_URL) {
      const { default: IORedis } = await import('ioredis');
      const redis = new IORedis(REDIS_URL, { lazyConnect: true });
      return createRateLimiter({ backend: new RedisRateBackend(redis), ...opts });
    }
    warnMockOnce();
    return createRateLimiter({ backend: new MemoryRateBackend(), ...opts });
  })();
  return storefrontLimiter;
}

export async function checkStorefrontRate(key: string): Promise<RateCheckResult> {
  return (await getStorefrontLimiter()).checkLoginRate(key);
}

export async function registerStorefrontHit(key: string): Promise<void> {
  return (await getStorefrontLimiter()).registerLoginFailure(key);
}

export async function resetLoginFailures(key: string): Promise<void> {
  return (await getDefaultLimiter()).resetLoginFailures(key);
}
