import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Миграция шага 6 (docs/24 §4): 0043_reviews.
 *
 * (а) ЮНИТ (без БД): файл существует, аддитивен/идемпотентен (IF NOT EXISTS,
 *     rating CHECK 1..5, status CHECK, FK product/customer через DO-блоки,
 *     CHECK jsonb_typeof, GRANT admik_app, schema_migrations ON CONFLICT).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат идемпотентен, таблица
 *     и колонки на месте.
 */

function stripSqlComments(s: string): string {
  return s.replace(/--[^\n]*/g, '').replace(/[ \t]+/g, ' ');
}
async function getMigration(version: string) {
  return (await listMigrations()).find((m) => m.version === version);
}
async function body(version: string): Promise<string> {
  const m = await getMigration(version);
  return stripSqlComments(await readFile(m!.path, 'utf8'));
}

describe('db/migrations — 0043_reviews (юнит)', () => {
  it('файл 0043 существует с именем reviews', async () => {
    const m = await getMigration('0043');
    expect(m).toBeDefined();
    expect(m!.name).toBe('reviews');
  });

  it('CREATE TABLE IF NOT EXISTS reviews', async () => {
    const lower = (await body('0043')).toLowerCase();
    expect(lower).toContain('create table if not exists reviews');
  });

  it('rating smallint CHECK 1..5', async () => {
    const lower = (await body('0043')).toLowerCase();
    expect(lower).toContain('rating smallint');
    expect(lower).toContain('rating between 1 and 5');
  });

  it('status CHECK pending/approved/rejected DEFAULT pending', async () => {
    const lower = (await body('0043')).toLowerCase();
    for (const s of ['pending', 'approved', 'rejected']) {
      expect(lower).toContain(`'${s}'`);
    }
    expect(lower).toContain("default 'pending'");
  });

  it('FK product (CASCADE) и customer (SET NULL) через DO-блоки', async () => {
    const lower = (await body('0043')).toLowerCase();
    expect(lower).toContain('reviews_product_id_fkey');
    expect(lower).toContain('references products(id) on delete cascade');
    expect(lower).toContain('reviews_customer_id_fkey');
    expect(lower).toContain('references customers(id) on delete set null');
  });

  it('i18n: translations jsonb с CHECK jsonb_typeof=object (DO-блок)', async () => {
    const lower = (await body('0043')).toLowerCase();
    expect(lower).toContain("translations jsonb not null default '{}'::jsonb");
    expect(lower).toContain("jsonb_typeof(translations) = 'object'");
    expect(lower).toContain('reviews_translations_obj_chk');
  });

  it('ключевые поля порта b_comments присутствуют', async () => {
    const lower = (await body('0043')).toLowerCase();
    for (const col of [
      'product_id', 'customer_id', 'author_name', 'body', 'rating', 'status',
      'reply', 'is_verified', 'source', 'created_at', 'published_at',
    ]) {
      expect(lower).toContain(col);
    }
  });

  it('GRANT admik_app + schema_migrations ON CONFLICT', async () => {
    const lower = (await body('0043')).toLowerCase();
    expect(lower).toContain('grant select, insert, update, delete on reviews to admik_app');
    expect(lower).toContain("insert into schema_migrations");
    expect(lower).toContain('on conflict do nothing');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД (двойной накат идемпотентен).
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — 0043 (интеграция)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  afterAll(async () => {
    if (closeSql) await closeSql();
  });

  it('таблица reviews существует с ключевыми колонками', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'reviews'
    `;
    const names = new Set(cols.map((c) => c.column_name));
    for (const c of ['id', 'product_id', 'customer_id', 'author_name', 'body',
      'rating', 'status', 'reply', 'translations', 'created_at', 'published_at']) {
      expect(names.has(c)).toBe(true);
    }
  });

  it('rating CHECK отвергает 0 и 6', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    // Нужен валидный товар для FK.
    const p = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name) VALUES
        (${'rev-chk-' + Math.random().toString(36).slice(2, 8)},
         ${'rev-chk-' + Math.random().toString(36).slice(2, 8)}, 'chk')
      RETURNING id
    `;
    const pid = p[0]!.id;
    try {
      await expect(
        sql`INSERT INTO reviews (product_id, author_name, body, rating)
            VALUES (${pid}, 'A', 'b', 0)`,
      ).rejects.toThrow();
      await expect(
        sql`INSERT INTO reviews (product_id, author_name, body, rating)
            VALUES (${pid}, 'A', 'b', 6)`,
      ).rejects.toThrow();
    } finally {
      await sql`DELETE FROM products WHERE id = ${pid}`;
    }
  });
});
