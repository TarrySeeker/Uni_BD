import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Миграции шага 7a (docs/24 §6): 0044_customer_credentials, 0045_customer_sessions,
 * 0046_customer_auth_tokens.
 *
 * (а) ЮНИТ (без БД): файлы аддитивны/идемпотентны (ADD COLUMN/CREATE IF NOT EXISTS,
 *     CHECK/FK через DO-блоки, GRANT, schema_migrations ON CONFLICT).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): колонки/таблицы на месте, CHECK/FK
 *     энфорсятся, одноразовость токена и уникальность token_hash работают.
 */

function stripSqlComments(s: string): string {
  return s.replace(/--[^\n]*/g, '').replace(/[ \t]+/g, ' ');
}
async function body(version: string): Promise<string> {
  const m = (await listMigrations()).find((x) => x.version === version);
  return stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
}

describe('db/migrations — 0044 customer_credentials (юнит)', () => {
  it('аддитивно расширяет customers (ADD COLUMN IF NOT EXISTS)', async () => {
    const b = await body('0044');
    for (const col of ['password_hash', 'status', 'email_verified_at', 'last_login_at', 'preferred_locale']) {
      expect(b).toContain(`add column if not exists ${col}`);
    }
  });

  it('status DEFAULT guest + CHECK guest/active/disabled', async () => {
    const b = await body('0044');
    expect(b).toContain("default 'guest'");
    expect(b).toContain('customers_status_chk');
    for (const s of ['guest', 'active', 'disabled']) expect(b).toContain(`'${s}'`);
  });

  it('customers_account_pwd_chk NOT VALID (active требует пароль)', async () => {
    const b = await body('0044');
    expect(b).toContain('customers_account_pwd_chk');
    expect(b).toContain('not valid');
  });

  it('schema_migrations 0044 ON CONFLICT', async () => {
    const b = await body('0044');
    expect(b).toContain("insert into schema_migrations");
    expect(b).toContain("'0044'");
    expect(b).toContain('on conflict do nothing');
  });
});

describe('db/migrations — 0045 customer_sessions (юнит)', () => {
  it('CREATE TABLE IF NOT EXISTS + FK CASCADE + GRANT', async () => {
    const b = await body('0045');
    expect(b).toContain('create table if not exists customer_sessions');
    expect(b).toContain('references customers(id) on delete cascade');
    expect(b).toContain('grant select, insert, update, delete on customer_sessions to admik_app');
    expect(b).toContain("'0045'");
  });
});

describe('db/migrations — 0046 customer_auth_tokens (юнит)', () => {
  it('таблица + purpose CHECK + UNIQUE(token_hash) + FK CASCADE', async () => {
    const b = await body('0046');
    expect(b).toContain('create table if not exists customer_auth_tokens');
    expect(b).toContain('customer_auth_tokens_purpose_chk');
    expect(b).toContain('password_reset');
    expect(b).toContain('email_verify');
    expect(b).toContain('create unique index if not exists customer_auth_tokens_hash_uniq');
    expect(b).toContain('references customers(id) on delete cascade');
    expect(b).toContain("'0046'");
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД (:5434).
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — 0044-0046 (интеграция)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  afterAll(async () => {
    if (closeSql) await closeSql();
  });

  it('customers несёт учётные колонки', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'
    `;
    const names = new Set(cols.map((c) => c.column_name));
    for (const c of ['password_hash', 'status', 'email_verified_at', 'last_login_at', 'preferred_locale']) {
      expect(names.has(c)).toBe(true);
    }
  });

  it('таблицы customer_sessions и customer_auth_tokens существуют', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    const t = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('customer_sessions', 'customer_auth_tokens')
    `;
    expect(new Set(t.map((x) => x.table_name))).toEqual(
      new Set(['customer_sessions', 'customer_auth_tokens']),
    );
  });

  it('customers_status_chk отвергает неизвестный статус', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    const email = `mig-chk-${Math.random().toString(36).slice(2, 8)}@x.io`;
    await expect(
      sql`INSERT INTO customers (email, status) VALUES (${email}, 'bogus')`,
    ).rejects.toThrow();
  });

  it('customer_auth_tokens.token_hash UNIQUE', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    const email = `mig-tok-${Math.random().toString(36).slice(2, 8)}@x.io`;
    const c = await sql<{ id: string }[]>`
      INSERT INTO customers (email, status) VALUES (${email}, 'guest') RETURNING id
    `;
    const cid = c[0]!.id;
    const th = 'hash-' + Math.random().toString(36).slice(2);
    const exp = new Date(Date.now() + 3600_000);
    try {
      await sql`
        INSERT INTO customer_auth_tokens (customer_id, purpose, token_hash, expires_at)
        VALUES (${cid}, 'password_reset', ${th}, ${exp})
      `;
      await expect(
        sql`
          INSERT INTO customer_auth_tokens (customer_id, purpose, token_hash, expires_at)
          VALUES (${cid}, 'password_reset', ${th}, ${exp})
        `,
      ).rejects.toThrow();
    } finally {
      await sql`DELETE FROM customers WHERE id = ${cid}`; // CASCADE уносит токены/сессии
    }
  });
});
