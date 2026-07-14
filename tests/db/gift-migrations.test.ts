import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Миграции под-шага 4a (docs/24 §5): 0039_gift_certificates,
 * 0040_gift_certificate_redemptions, 0041_orders_gift_columns.
 *
 * (а) ЮНИТ (без БД): файлы существуют, аддитивны/идемпотентны (IF NOT EXISTS,
 *     CHECK через DO-блок, GRANT admik_app, schema_migrations ON CONFLICT).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат, таблицы/колонки на месте.
 */

function stripSqlComments(s: string): string {
  // Убираем комментарии и схлопываем выравнивающие пробелы (колонки в CREATE TABLE
  // выровнены множественными пробелами) — сравнения ведём по одному пробелу.
  return s.replace(/--[^\n]*/g, '').replace(/[ \t]+/g, ' ');
}
async function getMigration(version: string) {
  return (await listMigrations()).find((m) => m.version === version);
}
async function body(version: string): Promise<string> {
  const m = await getMigration(version);
  return stripSqlComments(await readFile(m!.path, 'utf8'));
}

describe('db/migrations — 0039_gift_certificates (юнит)', () => {
  it('файл 0039 существует с именем gift_certificates', async () => {
    const m = await getMigration('0039');
    expect(m).toBeDefined();
    expect(m!.name).toBe('gift_certificates');
  });

  it('CREATE TABLE IF NOT EXISTS + уникальный код', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('create table if not exists gift_certificates');
    expect(lower).toContain('create unique index if not exists gift_certificates_code_uniq');
  });

  it('баланс: initial_amount > 0, spent_total default 0, инвариант 0 <= spent <= initial', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('initial_amount');
    expect(lower).toContain('check (initial_amount > 0)');
    expect(lower).toContain('spent_total');
    expect(lower).toContain('spent_total >= 0 and spent_total <= initial_amount');
  });

  it('status CHECK active/depleted/disabled/expired', async () => {
    const lower = (await body('0039')).toLowerCase();
    for (const s of ['active', 'depleted', 'disabled', 'expired']) {
      expect(lower).toContain(`'${s}'`);
    }
  });

  it('i18n: description/terms + translations jsonb с CHECK jsonb_typeof=object (DO-блок)', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('description');
    expect(lower).toContain('terms');
    expect(lower).toContain("translations jsonb not null default '{}'::jsonb");
    expect(lower).toContain("jsonb_typeof(translations) = 'object'");
    expect(lower).toContain('pg_constraint'); // идемпотентный DO-блок
  });

  it('GRANT admik_app + schema_migrations ON CONFLICT', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('to admik_app');
    expect(lower).toContain("insert into schema_migrations");
    expect(lower).toContain('on conflict do nothing');
  });
});

describe('db/migrations — 0040_gift_certificate_redemptions (юнит)', () => {
  it('файл 0040 существует', async () => {
    expect((await getMigration('0040'))!.name).toBe('gift_certificate_redemptions');
  });

  it('леджер: FK на сертификат и заказ, amount > 0, UNIQUE(cert,order) для идемпотентности', async () => {
    const lower = (await body('0040')).toLowerCase();
    expect(lower).toContain('create table if not exists gift_certificate_redemptions');
    expect(lower).toContain('references gift_certificates(id) on delete cascade');
    expect(lower).toContain('references orders(id)');
    expect(lower).toContain('check (amount > 0)');
    expect(lower).toContain('create unique index if not exists gift_cert_redemptions_order_uniq');
    expect(lower).toContain('reversed_at'); // задел под release/рефанд
  });
});

describe('db/migrations — 0041_orders_gift_columns (юнит)', () => {
  it('файл 0041 существует', async () => {
    expect((await getMigration('0041'))!.name).toBe('orders_gift_columns');
  });

  it('аддитивные колонки orders: gift_certificate_id (FK), gift_discount_total (>=0)', async () => {
    const lower = (await body('0041')).toLowerCase();
    expect(lower).toContain('alter table orders add column if not exists gift_certificate_id uuid');
    expect(lower).toContain('alter table orders add column if not exists gift_discount_total numeric(14,2) not null default 0');
    expect(lower).toContain('orders_gift_discount_nonneg_chk');
    expect(lower).toContain('references gift_certificates(id) on delete set null');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — двойной накат (идемпотентность) + структура.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations 0039-0041 (интеграция)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  afterAll(async () => {
    if (closeSql) await closeSql();
  });

  it('таблицы и колонки существуют после наката', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;

    const [t] = await sql<{ a: string | null; b: string | null }[]>`
      SELECT to_regclass('public.gift_certificates')::text AS a,
             to_regclass('public.gift_certificate_redemptions')::text AS b
    `;
    expect(t!.a).toBe('gift_certificates');
    expect(t!.b).toBe('gift_certificate_redemptions');

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name IN ('gift_certificate_id', 'gift_discount_total')
    `;
    expect(cols.map((c) => c.column_name).sort()).toEqual(['gift_certificate_id', 'gift_discount_total']);

    const [reg] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM schema_migrations WHERE version IN ('0039','0040','0041')
    `;
    expect(reg!.n).toBe('3');
  });
});
