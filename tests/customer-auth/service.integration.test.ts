import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — сервис customer-auth end-to-end на :5434
 * (docs/24 §6). register(хеш верифицируется, дубль email → generic), login(верный/
 * неверный → единый 401, сессия), logout(инвалидация), reset(одноразовость, anti-
 * enum), rate-limit, ИЗОЛЯЦИЯ от admin-сессий.
 */
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('customer-auth/service (интеграция)', () => {
  let svc: typeof import('@/lib/customer-auth/service');
  let session: typeof import('@/lib/customer-auth/session');
  let adminSession: typeof import('@/lib/auth/session');
  let rateLimit: typeof import('@/lib/auth/rate-limit');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const tag = 'itsvc-' + Math.random().toString(36).slice(2, 8);
  const emails: string[] = [];
  let ipCounter = 0;

  function freshEmail(): string {
    const e = `${tag}-${emails.length}@example.io`;
    emails.push(e);
    return e;
  }
  /** Уникальный ip на тест — чтобы rate-limit-вёдра не пересекались между кейсами. */
  function freshIp(): string {
    ipCounter += 1;
    return `198.51.100.${ipCounter % 250}`;
  }

  beforeAll(async () => {
    svc = await import('@/lib/customer-auth/service');
    session = await import('@/lib/customer-auth/session');
    adminSession = await import('@/lib/auth/session');
    rateLimit = await import('@/lib/auth/rate-limit');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  beforeEach(() => {
    // Чистим in-memory лимитер между кейсами (счётчики не должны течь).
    rateLimit.resetDefaultLimiter();
  });

  afterAll(async () => {
    for (const e of emails) await sql`DELETE FROM customers WHERE email = ${e}`;
    if (closeSql) await closeSql();
  });

  it('register: создаёт аккаунт, пароль верифицируется через login', async () => {
    const email = freshEmail();
    const res = await svc.register(
      { email, password: 'sup3rsecret1', name: 'Покупатель' },
      { ip: freshIp() },
    );
    expect(res.customer.status).toBe('active');
    expect(res.sessionToken).toHaveLength(32);
    // Хеш реально сохранён и проверяем: логин тем же паролем проходит.
    const login = await svc.login({ email, password: 'sup3rsecret1' }, { ip: freshIp() });
    expect(login.customer.email).toBe(email);
  });

  it('register: дубль активного email → RegistrationFailedError (generic)', async () => {
    const email = freshEmail();
    await svc.register({ email, password: 'firstpass12' }, { ip: freshIp() });
    await expect(
      svc.register({ email, password: 'secondpass34' }, { ip: freshIp() }),
    ).rejects.toMatchObject({ name: 'RegistrationFailedError' });
  });

  it('login: неверный пароль → InvalidCredentialsError (единый 401)', async () => {
    const email = freshEmail();
    await svc.register({ email, password: 'rightpass123' }, { ip: freshIp() });
    await expect(
      svc.login({ email, password: 'wrongpass999' }, { ip: freshIp() }),
    ).rejects.toMatchObject({ name: 'InvalidCredentialsError' });
  });

  it('login: несуществующий email → тот же InvalidCredentialsError (anti-enum)', async () => {
    await expect(
      svc.login({ email: `nobody-${tag}@x.io`, password: 'whatever12' }, { ip: freshIp() }),
    ).rejects.toMatchObject({ name: 'InvalidCredentialsError' });
  });

  it('login: disabled аккаунт → InvalidCredentialsError', async () => {
    const email = freshEmail();
    const r = await svc.register({ email, password: 'disabled123' }, { ip: freshIp() });
    await sql`UPDATE customers SET status = 'disabled' WHERE id = ${r.customer.id}`;
    await expect(
      svc.login({ email, password: 'disabled123' }, { ip: freshIp() }),
    ).rejects.toMatchObject({ name: 'InvalidCredentialsError' });
  });

  it('login создаёт валидную сессию; logout её инвалидирует', async () => {
    const email = freshEmail();
    await svc.register({ email, password: 'logoutpass1' }, { ip: freshIp() });
    const res = await svc.login({ email, password: 'logoutpass1' }, { ip: freshIp() });
    expect(await svc.getMe(res.sessionToken)).not.toBeNull();
    await svc.logout(res.sessionToken);
    expect(await svc.getMe(res.sessionToken)).toBeNull();
  });

  it('reset: request→confirm одноразово, новый пароль работает, старые сессии убиты', async () => {
    const email = freshEmail();
    const reg = await svc.register({ email, password: 'oldpass1234' }, { ip: freshIp() });
    const oldSession = reg.sessionToken;

    const { rawToken } = await svc.requestPasswordReset(email, { ip: freshIp() });
    expect(rawToken).not.toBeNull();

    await svc.confirmPasswordReset(rawToken!, 'brandnew5678', { ip: freshIp() });

    // Все прежние сессии инвалидированы (выход со всех устройств).
    expect(await svc.getMe(oldSession)).toBeNull();
    // Новый пароль работает, старый — нет.
    await expect(
      svc.login({ email, password: 'oldpass1234' }, { ip: freshIp() }),
    ).rejects.toMatchObject({ name: 'InvalidCredentialsError' });
    const relog = await svc.login({ email, password: 'brandnew5678' }, { ip: freshIp() });
    expect(relog.customer.email).toBe(email);

    // Токен одноразовый: повторное подтверждение → InvalidTokenError.
    await expect(
      svc.confirmPasswordReset(rawToken!, 'another9999', { ip: freshIp() }),
    ).rejects.toMatchObject({ name: 'InvalidTokenError' });
  });

  it('reset-request: несуществующий email → generic (rawToken null, без утечки)', async () => {
    const { rawToken } = await svc.requestPasswordReset(`ghost-${tag}@x.io`, { ip: freshIp() });
    expect(rawToken).toBeNull();
  });

  it('confirmPasswordReset: неизвестный токен → InvalidTokenError', async () => {
    await expect(
      svc.confirmPasswordReset('deadbeef-not-a-real-token', 'whatever1234', { ip: freshIp() }),
    ).rejects.toMatchObject({ name: 'InvalidTokenError' });
  });

  it('rate-limit: серия неверных логинов с одного ip/email → RateLimitedError', async () => {
    const email = freshEmail();
    await svc.register({ email, password: 'ratelimit123' }, { ip: freshIp() });
    const ip = freshIp();
    // 10 неудач заполняют окно (порог 10/15мин).
    for (let i = 0; i < 10; i++) {
      await expect(
        svc.login({ email, password: 'definitely-wrong' }, { ip }),
      ).rejects.toMatchObject({ name: 'InvalidCredentialsError' });
    }
    // 11-я попытка блокируется ДО проверки пароля.
    await expect(
      svc.login({ email, password: 'ratelimit123' }, { ip }),
    ).rejects.toMatchObject({ name: 'RateLimitedError' });
  });

  it('ИЗОЛЯЦИЯ: токен покупательской сессии НЕ валиден как admin-сессия', async () => {
    const email = freshEmail();
    const res = await svc.register({ email, password: 'isolate1234' }, { ip: freshIp() });
    // Токен есть в customer_sessions, но admin validateSession читает ДРУГУЮ таблицу.
    expect(await session.validateCustomerSession(res.sessionToken)).not.toBeNull();
    expect(await adminSession.validateSession(res.sessionToken)).toBeNull();
  });
});
