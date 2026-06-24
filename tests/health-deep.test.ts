import { describe, it, expect } from 'vitest';
import {
  aggregateHealth,
  type CheckResult,
  type DeepHealthInput,
} from '@/lib/health';

/**
 * Контракт deep-check агрегации /api/health (Этап 6, пакет 6.3, §6.3.2; ADR-015).
 *
 * aggregateHealth — ЧИСТАЯ функция: принимает результаты проверок {db, redis, s3}
 * и возвращает {status, checks, httpStatus}. БД — критична: её недоступность →
 * status 'error' + HTTP 503. Redis/S3 — не критичны (mock/skipped допустимы):
 * их недоступность деградирует в 'degraded', но liveness deep-check не валит 503.
 * Тестируется на МОКАХ — без реальных подключений (паттерн skipIf — для интеграции).
 */

const ok = (latencyMs = 1): CheckResult => ({ status: 'ok', latencyMs });
const down = (error = 'boom'): CheckResult => ({ status: 'error', error });
const skipped = (): CheckResult => ({ status: 'skipped' });

describe('lib/health · aggregateHealth', () => {
  it('все проверки ok → status ok, HTTP 200', () => {
    const input: DeepHealthInput = { db: ok(), redis: ok(), s3: ok() };
    const res = aggregateHealth(input);
    expect(res.status).toBe('ok');
    expect(res.httpStatus).toBe(200);
    expect(res.checks.db.status).toBe('ok');
  });

  it('redis/s3 пропущены (mock) → status ok, HTTP 200 (не критичны)', () => {
    const input: DeepHealthInput = { db: ok(), redis: skipped(), s3: skipped() };
    const res = aggregateHealth(input);
    expect(res.status).toBe('ok');
    expect(res.httpStatus).toBe(200);
  });

  it('критичная зависимость (db) недоступна → status error, HTTP 503', () => {
    const input: DeepHealthInput = { db: down('ECONNREFUSED'), redis: ok(), s3: ok() };
    const res = aggregateHealth(input);
    expect(res.status).toBe('error');
    expect(res.httpStatus).toBe(503);
    expect(res.checks.db.status).toBe('error');
    expect(res.checks.db.error).toBe('ECONNREFUSED');
  });

  it('некритичная зависимость (redis) недоступна → status degraded, HTTP 200', () => {
    const input: DeepHealthInput = { db: ok(), redis: down(), s3: ok() };
    const res = aggregateHealth(input);
    expect(res.status).toBe('degraded');
    expect(res.httpStatus).toBe(200);
    expect(res.checks.redis.status).toBe('error');
  });

  it('некритичный s3 недоступен → degraded, HTTP 200', () => {
    const input: DeepHealthInput = { db: ok(), redis: ok(), s3: down() };
    const res = aggregateHealth(input);
    expect(res.status).toBe('degraded');
    expect(res.httpStatus).toBe(200);
  });

  it('db недоступна имеет приоритет над degraded → error + 503', () => {
    const input: DeepHealthInput = { db: down(), redis: down(), s3: down() };
    const res = aggregateHealth(input);
    expect(res.status).toBe('error');
    expect(res.httpStatus).toBe(503);
  });

  it('возвращает полную карту checks для всех трёх зависимостей', () => {
    const input: DeepHealthInput = { db: ok(5), redis: skipped(), s3: down('x') };
    const res = aggregateHealth(input);
    expect(Object.keys(res.checks).sort()).toEqual(['db', 'redis', 's3']);
    expect(res.checks.db.latencyMs).toBe(5);
  });
});
