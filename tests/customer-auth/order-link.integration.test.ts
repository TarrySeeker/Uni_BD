import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — связка гость→аккаунт по email + верификация
 * email (docs/24 §6, шаг 7b). Реальная БД :5434, миграции 0013/0044/0046.
 *
 * Проверяет:
 *  - linkGuestOrdersByEmail: привязывает ТОЛЬКО гостевые (customer_id IS NULL) заказы
 *    того же email (регистронезависимо, citext), возвращает счётчик; чужой email и
 *    уже привязанные заказы не трогает; повтор идемпотентен (0);
 *  - markEmailVerified: ставит email_verified_at, идемпотентен (первый момент сохраняется);
 *  - confirmEmailVerification: одноразовый email_verify-токен (single-use), ставит
 *    verified + линкует гостевые заказы; истёкший/повторный токен → InvalidTokenError,
 *    БЕЗ верификации и линковки;
 *  - линковка ТОЛЬКО после verify: register при дефолте (verification required) НЕ
 *    линкует; при отключённой владельцем верификации — линкует сразу;
 *  - чужой/неверифицированный email не присваивает заказы;
 *  - listCustomerOrders показывает привязанные заказы.
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('customer-auth — связка гость→аккаунт + email verify (интеграция)', () => {
  let repo: typeof import('@/lib/customer-auth/repository');
  let service: typeof import('@/lib/customer-auth/service');
  let token: typeof import('@/lib/customer-auth/token');
  let envMod: typeof import('@/lib/config/env');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const tag = 'itlink-' + Math.random().toString(36).slice(2, 8);
  const emails: string[] = [];
  let ipCounter = 0;

  function freshEmail(): string {
    const e = `${tag}-${emails.length}@Example.io`; // намеренно смешанный регистр
    emails.push(e.toLowerCase());
    return e;
  }
  function freshIp(): string {
    return `203.0.113.${(ipCounter++ % 250) + 1}`;
  }

  /** Минимальный ГОСТЕВОЙ заказ (customer_id NULL) с заданным email/регистром. */
  async function insertGuestOrder(email: string, customerId: string | null = null): Promise<string> {
    const number = 'LNK-' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO orders (number, items_total, grand_total, customer_id,
                          customer_name, customer_email, customer_phone)
      VALUES (${number}, '100.00', '100.00', ${customerId},
              'Гость', ${email}, '+70000000000')
      RETURNING id
    `;
    return o!.id;
  }

  async function orderOwner(orderId: string): Promise<string | null> {
    const [row] = await sql<{ customer_id: string | null }[]>`
      SELECT customer_id FROM orders WHERE id = ${orderId}
    `;
    return row!.customer_id;
  }

  beforeAll(async () => {
    repo = await import('@/lib/customer-auth/repository');
    service = await import('@/lib/customer-auth/service');
    token = await import('@/lib/customer-auth/token');
    envMod = await import('@/lib/config/env');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  beforeEach(() => {
    // Каждый тест стартует с дефолтной конфигурацией env (verification required=true),
    // если тест сам её не переопределил.
    delete process.env.CUSTOMER_EMAIL_VERIFICATION_REQUIRED;
    envMod.resetEnvCache();
  });

  afterAll(async () => {
    // Заказы удаляем по email (в т.ч. привязанные — каскад не тронет customers).
    const lowered = new Set(emails);
    for (const e of lowered) {
      await sql`DELETE FROM orders WHERE lower(customer_email) = ${e}`;
      await sql`DELETE FROM customers WHERE email = ${e}`; // CASCADE: сессии/токены
    }
    delete process.env.CUSTOMER_EMAIL_VERIFICATION_REQUIRED;
    envMod.resetEnvCache();
    if (closeSql) await closeSql();
  });

  // -- linkGuestOrdersByEmail --------------------------------------------------

  it('linkGuestOrdersByEmail привязывает ТОЛЬКО гостевые заказы того же email (citext), идемпотентно', async () => {
    const email = freshEmail();
    const acct = await repo.insertOrUpgradeAccount({ email: email.toLowerCase(), passwordHash: '$h' });
    // Два гостевых заказа этого email (разный регистр), один чужой, один уже привязанный.
    const g1 = await insertGuestOrder(email); // смешанный регистр
    const g2 = await insertGuestOrder(email.toLowerCase());
    const otherEmail = freshEmail();
    const foreign = await insertGuestOrder(otherEmail);
    const alreadyOwned = await insertGuestOrder(email, acct!.id); // уже с customer_id

    const n = await repo.linkGuestOrdersByEmail(acct!.id, email.toLowerCase());
    expect(n).toBe(2); // ровно два свободных гостевых заказа

    expect(await orderOwner(g1)).toBe(acct!.id);
    expect(await orderOwner(g2)).toBe(acct!.id);
    expect(await orderOwner(foreign)).toBeNull(); // чужой email не тронут
    expect(await orderOwner(alreadyOwned)).toBe(acct!.id); // остался как был

    // Идемпотентность: повтор ничего нового не привязывает.
    expect(await repo.linkGuestOrdersByEmail(acct!.id, email.toLowerCase())).toBe(0);
  });

  it('linkGuestOrdersByEmail НЕ присваивает заказы чужого email', async () => {
    const emailA = freshEmail();
    const emailB = freshEmail();
    const acctB = await repo.insertOrUpgradeAccount({ email: emailB.toLowerCase(), passwordHash: '$h' });
    const guestA = await insertGuestOrder(emailA); // заказ покупателя A

    const n = await repo.linkGuestOrdersByEmail(acctB!.id, emailB.toLowerCase());
    expect(n).toBe(0);
    expect(await orderOwner(guestA)).toBeNull(); // заказ A не украден аккаунтом B
  });

  // -- markEmailVerified -------------------------------------------------------

  it('markEmailVerified ставит email_verified_at и идемпотентен (первый момент сохраняется)', async () => {
    const email = freshEmail();
    const acct = await repo.insertOrUpgradeAccount({ email: email.toLowerCase(), passwordHash: '$h' });
    const first = await repo.markEmailVerified(acct!.id);
    expect(first).not.toBeNull();
    expect(first!.email.toLowerCase()).toBe(email.toLowerCase());
    const [r1] = await sql<{ email_verified_at: Date }[]>`
      SELECT email_verified_at FROM customers WHERE id = ${acct!.id}
    `;
    expect(r1!.email_verified_at).not.toBeNull();
    // Повтор не сдвигает момент.
    await repo.markEmailVerified(acct!.id);
    const [r2] = await sql<{ email_verified_at: Date }[]>`
      SELECT email_verified_at FROM customers WHERE id = ${acct!.id}
    `;
    expect(new Date(r2!.email_verified_at).getTime()).toBe(new Date(r1!.email_verified_at).getTime());
  });

  // -- confirmEmailVerification ------------------------------------------------

  it('confirmEmailVerification: одноразовый токен → verified + линковка гостевых заказов', async () => {
    const email = freshEmail();
    const acct = await repo.insertOrUpgradeAccount({ email: email.toLowerCase(), passwordHash: '$h' });
    const guest = await insertGuestOrder(email);

    const raw = token.generateRawToken();
    await repo.createAuthToken({
      customerId: acct!.id,
      purpose: 'email_verify',
      tokenHash: token.hashToken(raw),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await service.confirmEmailVerification(raw, { ip: freshIp() });
    expect(res.linkedOrders).toBe(1);
    expect(await orderOwner(guest)).toBe(acct!.id);
    const [row] = await sql<{ email_verified_at: Date }[]>`
      SELECT email_verified_at FROM customers WHERE id = ${acct!.id}
    `;
    expect(row!.email_verified_at).not.toBeNull();

    // Single-use: повтор того же токена → InvalidTokenError.
    await expect(service.confirmEmailVerification(raw, { ip: freshIp() })).rejects.toThrow();
  });

  it('confirmEmailVerification: истёкший токен → InvalidTokenError, БЕЗ verify и линковки', async () => {
    const email = freshEmail();
    const acct = await repo.insertOrUpgradeAccount({ email: email.toLowerCase(), passwordHash: '$h' });
    const guest = await insertGuestOrder(email);

    const raw = token.generateRawToken();
    await repo.createAuthToken({
      customerId: acct!.id,
      purpose: 'email_verify',
      tokenHash: token.hashToken(raw),
      expiresAt: new Date(Date.now() - 1000), // истёк
    });

    await expect(service.confirmEmailVerification(raw, { ip: freshIp() })).rejects.toThrow();
    // Заказ НЕ привязан, email НЕ подтверждён.
    expect(await orderOwner(guest)).toBeNull();
    const [row] = await sql<{ email_verified_at: Date | null }[]>`
      SELECT email_verified_at FROM customers WHERE id = ${acct!.id}
    `;
    expect(row!.email_verified_at).toBeNull();
  });

  it('requestEmailVerification → confirmEmailVerification (полный флоу) линкует заказы', async () => {
    const email = freshEmail();
    await repo.insertOrUpgradeAccount({ email: email.toLowerCase(), passwordHash: '$h' });
    const guest = await insertGuestOrder(email);

    const { rawToken } = await service.requestEmailVerification(email.toLowerCase(), { ip: freshIp() });
    expect(rawToken).not.toBeNull();
    const res = await service.confirmEmailVerification(rawToken!, { ip: freshIp() });
    expect(res.linkedOrders).toBe(1);
    expect(await orderOwner(guest)).not.toBeNull();
  });

  // -- линковка ТОЛЬКО после verify (гейт владельца) ---------------------------

  it('register при ДЕФОЛТЕ (verification required) НЕ линкует гостевые заказы', async () => {
    const email = freshEmail();
    const guest = await insertGuestOrder(email); // гость сделал заказ ДО регистрации
    // env по умолчанию: CUSTOMER_EMAIL_VERIFICATION_REQUIRED=true (beforeEach сбросил).
    await service.register({ email: email.toLowerCase(), password: 'password123' }, { ip: freshIp() });
    // Заказ НЕ привязан — ждём подтверждения email.
    expect(await orderOwner(guest)).toBeNull();
  });

  it('register при ОТКЛЮЧЁННОЙ владельцем верификации линкует заказы сразу', async () => {
    const email = freshEmail();
    const guest = await insertGuestOrder(email);
    process.env.CUSTOMER_EMAIL_VERIFICATION_REQUIRED = 'false';
    envMod.resetEnvCache();
    const res = await service.register(
      { email: email.toLowerCase(), password: 'password123' },
      { ip: freshIp() },
    );
    expect(await orderOwner(guest)).toBe(res.customer.id);
  });

  // -- listCustomerOrders ------------------------------------------------------

  it('listCustomerOrders показывает привязанные после verify заказы', async () => {
    const email = freshEmail();
    const acct = await repo.insertOrUpgradeAccount({ email: email.toLowerCase(), passwordHash: '$h' });
    await insertGuestOrder(email);
    await insertGuestOrder(email);
    // До линковки — история пуста.
    expect((await repo.listCustomerOrders(acct!.id)).length).toBe(0);

    const raw = token.generateRawToken();
    await repo.createAuthToken({
      customerId: acct!.id,
      purpose: 'email_verify',
      tokenHash: token.hashToken(raw),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await service.confirmEmailVerification(raw, { ip: freshIp() });

    const orders = await repo.listCustomerOrders(acct!.id);
    expect(orders.length).toBe(2);
  });
});
