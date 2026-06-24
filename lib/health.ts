/**
 * Deep-health-check зависимостей (Этап 6, пакет 6.3, §6.3.2; ADR-015).
 *
 * Разделение для тестируемости:
 *   * `aggregateHealth` — ЧИСТАЯ функция: из результатов проверок {db, redis, s3}
 *     строит {status, checks, httpStatus}. Тестируется на моках без подключений.
 *   * `checkDb/checkRedis/checkS3` — реальные пробы зависимостей (используют
 *     существующие клиенты). Гоняются только при наличии окружения (VPS/CI).
 *
 * Критичность: БД — критична (её падение → 503). Redis/S3 — не критичны:
 *   * Redis отсутствует (REDIS_URL пуст) → mock-режим rate-limit → 'skipped';
 *   * S3 не настроен → local/mock-хранилище → 'skipped';
 *   * их РЕАЛЬНОЕ падение деградирует сервис в 'degraded' (HTTP 200) — деградация,
 *     а не недоступность (бизнес-функции каталога/админки работают).
 */

import { getEnv } from '@/lib/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'health' });

export type CheckStatus = 'ok' | 'error' | 'skipped';

/**
 * Обобщённый код причины падения пробы для ПУБЛИЧНОГО ответа.
 *
 * SECURITY: сырой текст ошибки подключения (postgres/redis/s3) содержит
 * инфраструктурные детали — host/port/user/пароль/connection string. Отдавать
 * его неаутентифицированному клиенту нельзя (утечка деталей атакующему).
 * Наружу уходит только этот обобщённый код; полный текст — в серверный лог.
 */
export const HEALTH_ERROR_CODE = 'connection_failed';

/** Результат одной проверки зависимости. */
export interface CheckResult {
  status: CheckStatus;
  /** Латентность пробы (мс), если измерялась. */
  latencyMs?: number;
  /**
   * Обобщённый код причины (только для status='error'); НЕ сырой текст ошибки.
   * Сырой текст с инфраструктурными деталями пишется только в logger.error.
   */
  error?: string;
}

/** Входные результаты проверок для агрегации. */
export interface DeepHealthInput {
  db: CheckResult;
  redis: CheckResult;
  s3: CheckResult;
}

export type OverallStatus = 'ok' | 'degraded' | 'error';

/** Агрегированный ответ deep-health. */
export interface DeepHealthResult {
  status: OverallStatus;
  checks: DeepHealthInput;
  httpStatus: 200 | 503;
}

/** Критичные зависимости: их недоступность → 503. */
const CRITICAL: readonly (keyof DeepHealthInput)[] = ['db'];

/**
 * ЧИСТАЯ агрегация результатов в общий статус и HTTP-код.
 *   * критичная (db) error → status 'error', HTTP 503;
 *   * любая некритичная error → status 'degraded', HTTP 200;
 *   * иначе → status 'ok', HTTP 200 ('skipped' не считается ошибкой).
 */
export function aggregateHealth(input: DeepHealthInput): DeepHealthResult {
  const criticalDown = CRITICAL.some((key) => input[key].status === 'error');
  if (criticalDown) {
    return { status: 'error', checks: input, httpStatus: 503 };
  }

  const anyDown = (Object.keys(input) as (keyof DeepHealthInput)[]).some(
    (key) => input[key].status === 'error',
  );
  if (anyDown) {
    return { status: 'degraded', checks: input, httpStatus: 200 };
  }

  return { status: 'ok', checks: input, httpStatus: 200 };
}

/**
 * Формирует ПУБЛИЧНЫЙ результат упавшей пробы и пишет сырой текст в серверный лог.
 *
 * SECURITY: наружу отдаётся только обобщённый код HEALTH_ERROR_CODE. Полный
 * текст ошибки (host/port/user/connection string) НЕ покидает сервер — он
 * пишется в logger.error, как это делают остальные мутации (глотают internal,
 * логируя детали).
 */
function failure(component: keyof DeepHealthInput, error: unknown): CheckResult {
  const detail = error instanceof Error ? error.message : String(error);
  log.error('deep-health: проба зависимости упала', { component, detail });
  return { status: 'error', error: HEALTH_ERROR_CODE };
}

/** Проба БД: SELECT 1 через клиент приложения. Критична. */
export async function checkDb(): Promise<CheckResult> {
  const started = Date.now();
  try {
    const { sql } = await import('@/lib/db/client');
    await sql`SELECT 1`;
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (error) {
    return failure('db', error);
  }
}

/** Проба Redis: PING. Пропускается, если REDIS_URL не задан (mock-режим). */
export async function checkRedis(): Promise<CheckResult> {
  const { REDIS_URL } = getEnv();
  if (!REDIS_URL) {
    return { status: 'skipped' };
  }
  const started = Date.now();
  let redis: { ping: () => Promise<string>; quit: () => Promise<unknown> } | undefined;
  try {
    const { default: IORedis } = await import('ioredis');
    redis = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.ping();
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (error) {
    return failure('redis', error);
  } finally {
    if (redis) {
      await redis.quit().catch(() => undefined);
    }
  }
}

/**
 * Проба S3: HEAD bucket. Пропускается в local/mock-режиме (нет S3_ENDPOINT/S3_BUCKET).
 */
export async function checkS3(): Promise<CheckResult> {
  const env = getEnv();
  if (!env.S3_ENDPOINT || !env.S3_BUCKET) {
    return { status: 'skipped' };
  }
  const started = Date.now();
  // C6-4 (аудит цикла 6): объявлен ВНЕ try, чтобы освободить HTTP-агент в finally —
  // как redis.quit() выше. Иначе при частых health-пробах (мониторинг/LB-healthcheck)
  // новый S3Client на каждый вызов держит keep-alive сокеты → утечка FD/памяти.
  let client: import('@aws-sdk/client-s3').S3Client | undefined;
  try {
    const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
    client = new S3Client({
      region: env.S3_REGION ?? 'us-east-1',
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY,
              secretAccessKey: env.S3_SECRET_KEY,
            },
          }
        : {}),
    });
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (error) {
    return failure('s3', error);
  } finally {
    client?.destroy();
  }
}

/** Выполняет все три пробы параллельно и агрегирует результат. */
export async function runDeepHealth(): Promise<DeepHealthResult> {
  const [db, redis, s3] = await Promise.all([checkDb(), checkRedis(), checkS3()]);
  return aggregateHealth({ db, redis, s3 });
}
