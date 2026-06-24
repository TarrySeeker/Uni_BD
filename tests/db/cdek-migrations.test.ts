import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations, parseMigrationName } from '@/lib/db/migrate';

/**
 * Тесты пакета A Этапа 4 — миграции СДЭК 0017/0018 (docs/08 §3).
 *
 * (а) ЮНИТ — читают .sql с диска (без БД), проходят ВСЕГДА:
 *     наличие 0017/0018, идемпотентность (IF NOT EXISTS), запись в
 *     schema_migrations, GRANT для admik_app (0017), UNIQUE-идемпотентность
 *     cdek_status_log, FK через DO-блок, сплошная нумерация 0001..0018.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — двойной накат всех миграций,
 *     создание таблиц СДЭК, идемпотентная вставка в cdek_status_log (повтор → 1 ряд),
 *     добавление габаритов в products/product_variants.
 */

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

const CDEK_VERSIONS = ['0017', '0018'] as const;

async function listCdekMigrations() {
  const all = await listMigrations();
  return all.filter((m) => (CDEK_VERSIONS as readonly string[]).includes(m.version));
}

// =============================================================================
// (а) ЮНИТ — файлы миграций СДЭК. Без БД, всегда зелёные.
// =============================================================================
describe('db/migrations — СДЭК 0017/0018 (юнит)', () => {
  it('миграции 0017/0018 существуют и идут по порядку', async () => {
    const cdek = await listCdekMigrations();
    expect(cdek.map((m) => m.version)).toEqual([...CDEK_VERSIONS]);
  });

  it('имена миграций соответствуют контракту docs/08', async () => {
    const cdek = await listCdekMigrations();
    const byVersion = Object.fromEntries(cdek.map((m) => [m.version, m.name]));
    expect(byVersion['0017']).toBe('cdek_shipments');
    expect(byVersion['0018']).toBe('product_weight_dims');
  });

  it('нумерация без пропусков 0001..0018 сплошняком, 0018 завершает диапазон СДЭК', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    const expected = versions.map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
    for (const v of CDEK_VERSIONS) {
      expect(versions).toContain(v);
    }
    // 0018 завершает диапазон СДЭК (Этап 4); цепочку миграций после Этапа 4
    // продолжает Этап 5 (0019+), поэтому проверяем присутствие 0018, а не «хвост».
    expect(versions).toContain('0018');
    expect(parseMigrationName('0017_cdek_shipments.sql')).toEqual({
      version: '0017',
      name: 'cdek_shipments',
    });
  });

  it('каждая миграция СДЭК идемпотентна и пишет свою версию в schema_migrations', async () => {
    const cdek = await listCdekMigrations();
    for (const migration of cdek) {
      const sqlText = await readFile(migration.path, 'utf8');
      expect(sqlText).toContain('schema_migrations');
      expect(sqlText).toContain(`'${migration.version}'`);
      expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
    }
  });

  it('все CREATE TABLE/INDEX СДЭК используют IF NOT EXISTS (идемпотентность)', async () => {
    const cdek = await listCdekMigrations();
    for (const migration of cdek) {
      const upper = stripSqlComments(await readFile(migration.path, 'utf8')).toUpperCase();
      const creates = upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/g) ?? [];
      const guarded =
        upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/g) ?? [];
      expect(guarded.length, `в ${migration.name} есть незащищённый CREATE`).toBe(
        creates.length,
      );
    }
  });

  it('все ADD COLUMN в 0018 используют IF NOT EXISTS', async () => {
    const m0018 = (await listCdekMigrations()).find((m) => m.version === '0018')!;
    const upper = stripSqlComments(await readFile(m0018.path, 'utf8')).toUpperCase();
    const adds = upper.match(/ADD\s+COLUMN/g) ?? [];
    const guarded = upper.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/g) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(adds.length);
  });

  it('0017 выдаёт полный DML (S/I/U/D) на cdek_shipments и cdek_status_log', async () => {
    const m0017 = (await listCdekMigrations()).find((m) => m.version === '0017')!;
    const upper = stripSqlComments(await readFile(m0017.path, 'utf8')).toUpperCase();
    expect(upper).toMatch(
      /GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+CDEK_SHIPMENTS\s+TO\s+ADMIK_APP/,
    );
    expect(upper).toMatch(
      /GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+CDEK_STATUS_LOG\s+TO\s+ADMIK_APP/,
    );
  });

  it('0018 НЕ дублирует GRANT на products/product_variants (права уже выданы в 0006/0007)', async () => {
    const m0018 = (await listCdekMigrations()).find((m) => m.version === '0018')!;
    const upper = stripSqlComments(await readFile(m0018.path, 'utf8')).toUpperCase();
    expect(upper).not.toMatch(/GRANT[^;]*ON\s+PRODUCTS\s+TO\s+ADMIK_APP/);
    expect(upper).not.toMatch(/GRANT[^;]*ON\s+PRODUCT_VARIANTS\s+TO\s+ADMIK_APP/);
  });

  it('cdek_status_log имеет UNIQUE-индекс идемпотентности (uuid, code, date_time)', async () => {
    const m0017 = (await listCdekMigrations()).find((m) => m.version === '0017')!;
    const text = await readFile(m0017.path, 'utf8');
    expect(text).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_cdek_status_idem[\s\S]*cdek_uuid,\s*status_code,\s*status_date_time/,
    );
  });

  it('cdek_shipments имеет UNIQUE order_id (1:1 к заказу)', async () => {
    const m0017 = (await listCdekMigrations()).find((m) => m.version === '0017')!;
    const text = await readFile(m0017.path, 'utf8');
    expect(text).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_cdek_shipments_order\s+ON\s+cdek_shipments\s*\(order_id\)/,
    );
  });

  it('FK на orders добавляются идемпотентно (DO-блок + pg_constraint), CASCADE', async () => {
    const m0017 = (await listCdekMigrations()).find((m) => m.version === '0017')!;
    const text = await readFile(m0017.path, 'utf8');
    expect(text).toMatch(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint/);
    expect(text).toMatch(/cdek_shipments_order_fk[\s\S]*REFERENCES\s+orders\(id\)\s+ON\s+DELETE\s+CASCADE/);
    expect(text).toMatch(/cdek_status_log_order_fk[\s\S]*REFERENCES\s+orders\(id\)\s+ON\s+DELETE\s+CASCADE/);
  });

  it('CHECK ограничений 0018 (вес/габариты >= 0) — через DO-блок + pg_constraint', async () => {
    const m0018 = (await listCdekMigrations()).find((m) => m.version === '0018')!;
    const text = await readFile(m0018.path, 'utf8');
    expect(text).toMatch(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint/);
    expect(text).toMatch(/products_weight_nonneg[\s\S]*weight_g\s+IS\s+NULL\s+OR\s+weight_g\s+>=\s+0/);
    expect(text).toMatch(/variants_weight_nonneg/);
  });

  it('время — timestamptz, PK — uuid gen_random_uuid, деньги — numeric(14,2)', async () => {
    const m0017 = await readFile(
      (await listCdekMigrations()).find((m) => m.version === '0017')!.path,
      'utf8',
    );
    expect(m0017).toMatch(/timestamptz/);
    expect(m0017).toMatch(/uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(m0017).toMatch(/numeric\(14,2\)/);
    expect(m0017).toMatch(/raw_payload\s+jsonb/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. В этой среде PostgreSQL нет → skipIf.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — СДЭК (интеграция)', () => {
  let postgres: any;
  let listMigrationsFn: typeof listMigrations;
  let sql: any;

  function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  async function applyAllMigrations(): Promise<void> {
    const migrations = await listMigrationsFn();
    const appPassword = process.env.APP_PASSWORD ?? 'app_test_password';
    const migratorPassword = process.env.MIGRATOR_PASSWORD ?? 'migrator_test_password';
    for (const migration of migrations) {
      let text = await readFile(migration.path, 'utf8');
      text = text
        .replaceAll(":'APP_PASSWORD'", quoteLiteral(appPassword))
        .replaceAll(":'MIGRATOR_PASSWORD'", quoteLiteral(migratorPassword));
      await sql.unsafe(text);
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!postgres) {
      postgres = (await import('postgres')).default;
      const mod: typeof import('@/lib/db/migrate') = await import('@/lib/db/migrate');
      listMigrationsFn = mod.listMigrations;
    }
    if (!sql) {
      sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
    }
  }

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('двойной накат всех миграций (с СДЭК) не падает', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const first = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    await applyAllMigrations();
    const second = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    expect(second).toEqual(first);
    const versions = second.map((r: { version: string }) => r.version);
    for (const v of CDEK_VERSIONS) expect(versions).toContain(v);
  });

  it('таблицы cdek_shipments / cdek_status_log созданы', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const rows = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('cdek_shipments','cdek_status_log')
    `;
    const names = rows.map((r: { tablename: string }) => r.tablename).sort();
    expect(names).toEqual(['cdek_shipments', 'cdek_status_log']);
  });

  it('0018 добавил вес/габариты в products и product_variants', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('products','product_variants')
        AND column_name IN ('weight_g','length_cm','width_cm','height_cm')
    `;
    const set = new Set(cols.map((r: { table_name: string; column_name: string }) => `${r.table_name}.${r.column_name}`));
    for (const t of ['products', 'product_variants']) {
      for (const c of ['weight_g', 'length_cm', 'width_cm', 'height_cm']) {
        expect(set.has(`${t}.${c}`)).toBe(true);
      }
    }
  });

  it('admik_app имеет полный DML на cdek_shipments', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [priv] = await sql`
      SELECT
        has_table_privilege('admik_app','cdek_shipments','SELECT') AS s,
        has_table_privilege('admik_app','cdek_shipments','INSERT') AS i,
        has_table_privilege('admik_app','cdek_shipments','UPDATE') AS u,
        has_table_privilege('admik_app','cdek_shipments','DELETE') AS d
    `;
    expect([priv.s, priv.i, priv.u, priv.d]).toEqual([true, true, true, true]);
  });

  it('UNIQUE идемпотентности cdek_status_log: повтор события → один ряд', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [order] = await sql`
      INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone)
      VALUES (${'CDEK-IDEM-' + Date.now()}, 100, 100, 'T', 'idem@example.com', '+70000000000')
      RETURNING id`;
    const uuid = 'idem-uuid-' + Date.now();
    const insertOnce = () => sql`
      INSERT INTO cdek_status_log (order_id, cdek_uuid, status_code, status_date_time)
      VALUES (${order.id}, ${uuid}, 'DELIVERED', to_timestamp(1700000000))
      ON CONFLICT (cdek_uuid, status_code, status_date_time) DO NOTHING
      RETURNING id`;
    const first = await insertOnce();
    const second = await insertOnce();
    expect(first.length).toBe(1);
    expect(second.length).toBe(0); // дубликат не вставлен
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM cdek_status_log WHERE cdek_uuid = ${uuid}`;
    expect(count).toBe(1);
    await sql`DELETE FROM orders WHERE id = ${order.id}`; // CASCADE чистит лог
  });

  it('FK cdek_shipments.order_id = CASCADE: удаление заказа чистит отправление', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [order] = await sql`
      INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone)
      VALUES (${'CDEK-FK-' + Date.now()}, 100, 100, 'T', 'fk@example.com', '+70000000000')
      RETURNING id`;
    await sql`INSERT INTO cdek_shipments (order_id, is_mock) VALUES (${order.id}, true)`;
    await sql`DELETE FROM orders WHERE id = ${order.id}`;
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM cdek_shipments WHERE order_id = ${order.id}`;
    expect(count).toBe(0);
  });
});
