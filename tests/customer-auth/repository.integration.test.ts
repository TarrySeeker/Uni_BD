import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mapCustomer } from '@/lib/customer-auth/repository';
import { hashToken } from '@/lib/customer-auth/token';

/**
 * (а) ЮНИТ — маппер row→domain (без БД, без password_hash в результате).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — реальная БД :5434, миграции 0044-0046.
 *     UPSERT (new/guest-upgrade/taken), учётки, токены (одноразовость/expiry),
 *     сессии (create/validate/invalidate, disabled/expired отклонены), админ-листы.
 */
describe('customer-auth/repository — mapCustomer (юнит)', () => {
  it('snake→camel, без password_hash', () => {
    const c = mapCustomer({
      id: 'cid',
      email: 'a@b.io',
      name: 'Имя',
      phone: null,
      status: 'active',
      email_verified_at: null,
      last_login_at: null,
      preferred_locale: 'ru',
      orders_count: 2,
      total_spent: '100.00',
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-01'),
      // даже если row случайно принёс хеш — маппер его не пробрасывает:
      password_hash: '$argon2id$secret',
    });
    expect(c.email).toBe('a@b.io');
    expect(c.status).toBe('active');
    expect(c.ordersCount).toBe(2);
    expect(JSON.stringify(c)).not.toContain('argon2');
    expect(Object.keys(c)).not.toContain('passwordHash');
  });
});

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('customer-auth/repository (интеграция)', () => {
  let repo: typeof import('@/lib/customer-auth/repository');
  let session: typeof import('@/lib/customer-auth/session');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const tag = 'itcust-' + Math.random().toString(36).slice(2, 8);
  const emails: string[] = [];

  function freshEmail(): string {
    const e = `${tag}-${emails.length}@example.io`;
    emails.push(e);
    return e;
  }

  beforeAll(async () => {
    repo = await import('@/lib/customer-auth/repository');
    session = await import('@/lib/customer-auth/session');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    for (const e of emails) {
      await sql`DELETE FROM customers WHERE email = ${e}`; // CASCADE: сессии/токены
    }
    if (closeSql) await closeSql();
  });

  it('insertOrUpgradeAccount: свободный email → новый active-аккаунт с паролем', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({
      email,
      passwordHash: '$argon2id$v=19$fake',
      name: 'Новый',
    });
    expect(c).not.toBeNull();
    expect(c!.status).toBe('active');
    const creds = await repo.getCredentialsByEmail(email);
    expect(creds!.passwordHash).toBe('$argon2id$v=19$fake');
  });

  it('insertOrUpgradeAccount: ГОСТЬ по email → апгрейд с сохранением id', async () => {
    const email = freshEmail();
    const g = await sql<{ id: string }[]>`
      INSERT INTO customers (email, name, status) VALUES (${email}, 'Гость', 'guest') RETURNING id
    `;
    const guestId = g[0]!.id;
    const c = await repo.insertOrUpgradeAccount({
      email,
      passwordHash: '$argon2id$upgraded',
      name: '',
    });
    expect(c).not.toBeNull();
    expect(c!.id).toBe(guestId); // id-якорь сохранён (история заказов не рвётся)
    expect(c!.status).toBe('active');
  });

  it('insertOrUpgradeAccount: занятый АКТИВНЫЙ email → null (generic наружу)', async () => {
    const email = freshEmail();
    await repo.insertOrUpgradeAccount({ email, passwordHash: '$argon2id$first' });
    const second = await repo.insertOrUpgradeAccount({ email, passwordHash: '$argon2id$second' });
    expect(second).toBeNull();
    // Пароль первого НЕ перезаписан.
    const creds = await repo.getCredentialsByEmail(email);
    expect(creds!.passwordHash).toBe('$argon2id$first');
  });

  it('setPassword обновляет хеш и держит active', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$old' });
    const ok = await repo.setPassword(c!.id, '$new');
    expect(ok).toBe(true);
    const creds = await repo.getCredentialsByEmail(email);
    expect(creds!.passwordHash).toBe('$new');
    expect(creds!.status).toBe('active');
  });

  it('createAuthToken → consumeAuthToken одноразовый; повтор → null', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const hash = 'th-' + Math.random().toString(36).slice(2);
    await repo.createAuthToken({
      customerId: c!.id,
      purpose: 'password_reset',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(await repo.consumeAuthToken(hash, 'password_reset')).toBe(c!.id);
    // Второй раз — уже использован.
    expect(await repo.consumeAuthToken(hash, 'password_reset')).toBeNull();
  });

  it('consumeAuthToken: истёкший токен → null', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const hash = 'th-exp-' + Math.random().toString(36).slice(2);
    await repo.createAuthToken({
      customerId: c!.id,
      purpose: 'password_reset',
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 1000), // уже истёк
    });
    expect(await repo.consumeAuthToken(hash, 'password_reset')).toBeNull();
  });

  it('createAuthToken гасит прежние активные токены того же назначения', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const h1 = 'th-a-' + Math.random().toString(36).slice(2);
    const h2 = 'th-b-' + Math.random().toString(36).slice(2);
    await repo.createAuthToken({
      customerId: c!.id, purpose: 'password_reset', tokenHash: h1,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await repo.createAuthToken({
      customerId: c!.id, purpose: 'password_reset', tokenHash: h2,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // Первый уже погашен новым запросом.
    expect(await repo.consumeAuthToken(h1, 'password_reset')).toBeNull();
    expect(await repo.consumeAuthToken(h2, 'password_reset')).toBe(c!.id);
  });

  it('listCustomers/countCustomers фильтруют по подстроке', async () => {
    const email = freshEmail();
    await repo.insertOrUpgradeAccount({ email, passwordHash: '$h', name: 'Уник' });
    const rows = await repo.listCustomers({ q: email });
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe(email);
    expect(await repo.countCustomers({ q: email })).toBe(1);
  });

  // -- Сессии ---------------------------------------------------------------

  it('createCustomerSession + validateCustomerSession (active) → Customer', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const s = await session.createCustomerSession(c!.id, { ip: '203.0.113.5' });
    const validated = await session.validateCustomerSession(s.id);
    expect(validated).not.toBeNull();
    expect(validated!.id).toBe(c!.id);
    expect(validated!.email).toBe(email);
  });

  it('SECURITY: в БД лежит sha256(токена), НЕ сырой токен (7a security-medium)', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const s = await session.createCustomerSession(c!.id);
    // По СЫРОМУ токену строки в БД нет — id хранит хеш.
    const byRaw = await sql`SELECT id FROM customer_sessions WHERE id = ${s.id}`;
    expect(byRaw.length).toBe(0);
    // По sha256(сырого) — ровно одна строка.
    const byHash = await sql`SELECT id FROM customer_sessions WHERE id = ${hashToken(s.id)}`;
    expect(byHash.length).toBe(1);
    // Валидация по сырому токену всё равно работает (внутри хешируется).
    expect(await session.validateCustomerSession(s.id)).not.toBeNull();
  });

  it('validateCustomerSession: поддельный токен → null', async () => {
    expect(await session.validateCustomerSession('nonexistent-token-xyz')).toBeNull();
  });

  it('validateCustomerSession: истёкшая сессия → null + удалена (GC)', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const s = await session.createCustomerSession(c!.id);
    // Прямой SQL адресует строку по ХЕШУ (в БД id = sha256(сырого токена)).
    await sql`UPDATE customer_sessions SET expires_at = now() - interval '1 hour' WHERE id = ${hashToken(s.id)}`;
    expect(await session.validateCustomerSession(s.id)).toBeNull();
    const left = await sql`SELECT id FROM customer_sessions WHERE id = ${hashToken(s.id)}`;
    expect(left.length).toBe(0);
  });

  it('validateCustomerSession: disabled аккаунт → null', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const s = await session.createCustomerSession(c!.id);
    await sql`UPDATE customers SET status = 'disabled' WHERE id = ${c!.id}`;
    expect(await session.validateCustomerSession(s.id)).toBeNull();
  });

  it('invalidateCustomerSession и invalidateAllCustomerSessions', async () => {
    const email = freshEmail();
    const c = await repo.insertOrUpgradeAccount({ email, passwordHash: '$h' });
    const s1 = await session.createCustomerSession(c!.id);
    const s2 = await session.createCustomerSession(c!.id);
    await session.invalidateCustomerSession(s1.id);
    expect(await session.validateCustomerSession(s1.id)).toBeNull();
    expect(await session.validateCustomerSession(s2.id)).not.toBeNull();
    await session.invalidateAllCustomerSessions(c!.id);
    expect(await session.validateCustomerSession(s2.id)).toBeNull();
  });
});
