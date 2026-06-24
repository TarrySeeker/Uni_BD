import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Регресс-тест безопасности deep-health (/api/health?deep=1).
 *
 * БАГ (minor, security): при падении пробы зависимости сырой текст ошибки
 * подключения postgres/redis/s3 (содержит host/port/user/connection string)
 * попадал в ПУБЛИЧНЫЙ ответ через checks.*.error — утечка инфраструктурных
 * деталей неаутентифицированному атакующему.
 *
 * Контракт после фикса:
 *   * публичный CheckResult.error НЕ содержит сырых деталей подключения
 *     (host/port/user/пароль/connection string);
 *   * статус компонента ('error') сохранён + обобщённый код причины;
 *   * полный текст ошибки уходит ТОЛЬКО в logger.error (серверный лог).
 *   * deep-health 200-поведение для некритичных зависимостей не меняется.
 */

// Чувствительные подстроки, которых НЕ должно быть в публичном теле ответа.
const SECRET_HOST = 'db-internal.prod.admik.local';
const SECRET_PORT = '5433';
const SECRET_USER = 'admik_app_user';
const SECRET_PASSWORD = 's3cr3t-pg-pass';
const RAW_PG_ERROR =
  `connection to server at "${SECRET_HOST}" (10.8.0.4), port ${SECRET_PORT} failed: ` +
  `FATAL: password authentication failed for user "${SECRET_USER}" ` +
  `(connection string: postgres://${SECRET_USER}:${SECRET_PASSWORD}@${SECRET_HOST}:${SECRET_PORT}/admik)`;

// Логгер мокаем, чтобы убедиться: сырой текст уходит в серверный лог, а не наружу.
const logErrorSpy = vi.fn();
vi.mock('@/lib/logger', () => {
  const child = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logErrorSpy,
    child: () => child(),
  });
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: logErrorSpy,
      child,
    },
  };
});

// Клиент БД мокаем так, чтобы `sql` бросал ошибку с инфраструктурными деталями.
vi.mock('@/lib/db/client', () => {
  const sql = () => {
    throw new Error(RAW_PG_ERROR);
  };
  return { sql, getSql: () => sql, closeSql: vi.fn() };
});

describe('deep-health · утечка деталей ошибок наружу', () => {
  beforeEach(() => {
    logErrorSpy.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checkDb при ошибке подключения НЕ кладёт host/port/user/пароль/connection в публичный error', async () => {
    const { checkDb } = await import('@/lib/health');
    const result = await checkDb();

    expect(result.status).toBe('error');

    const publicBody = JSON.stringify(result);
    expect(publicBody).not.toContain(SECRET_HOST);
    expect(publicBody).not.toContain(SECRET_PORT);
    expect(publicBody).not.toContain(SECRET_USER);
    expect(publicBody).not.toContain(SECRET_PASSWORD);
    expect(publicBody.toLowerCase()).not.toContain('connection string');
    // raw-сообщение postgres целиком не должно просочиться
    expect(publicBody).not.toContain(RAW_PG_ERROR);
  });

  it('публичный error для упавшей пробы — обобщённый код, без сырого текста', async () => {
    const { checkDb } = await import('@/lib/health');
    const result = await checkDb();

    expect(result.error).toBe('connection_failed');
  });

  it('route /api/health?deep=1 не раскрывает инфраструктурные детали в теле ответа', async () => {
    const { GET } = await import('@/app/api/health/route');
    const req = {
      nextUrl: { searchParams: new URLSearchParams('deep=1') },
    } as unknown as import('next/server').NextRequest;

    const res = await GET(req);
    const text = JSON.stringify(await res.json());

    expect(text).not.toContain(SECRET_HOST);
    expect(text).not.toContain(SECRET_PORT);
    expect(text).not.toContain(SECRET_USER);
    expect(text).not.toContain(SECRET_PASSWORD);
    expect(text.toLowerCase()).not.toContain('connection string');
    expect(text).not.toContain(RAW_PG_ERROR);
    // структура статусов сохранена
    expect(text).toContain('"checks"');
    expect(text).toContain('"db"');
  });

  it('полный текст ошибки уходит в logger.error (серверный лог), а не наружу', async () => {
    const { GET } = await import('@/app/api/health/route');
    const req = {
      nextUrl: { searchParams: new URLSearchParams('deep=1') },
    } as unknown as import('next/server').NextRequest;

    await GET(req);

    // где-то в аргументах хотя бы одного вызова logger.error присутствует сырой текст
    const loggedRaw = logErrorSpy.mock.calls.some((call) =>
      JSON.stringify(call).includes(SECRET_HOST),
    );
    expect(loggedRaw).toBe(true);
  });
});
