import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations, parseMigrationName } from '@/lib/db/migrate';

/**
 * Тесты пакета П1 Этапа 2 — миграции каталога 0005…0010 (docs/05 §2).
 *
 * (а) ЮНИТ — читают .sql-файлы с диска (без БД), проходят ВСЕГДА:
 *     наличие файлов 0005..0010, идемпотентность (IF NOT EXISTS на всех CREATE),
 *     запись в schema_migrations, GRANT для admik_app, сплошная нумерация.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — двойной накат всех миграций,
 *     создание ключевых таблиц каталога, работа FK (RESTRICT/CASCADE).
 */

/**
 * Удаляет SQL-комментарии (-- ... до конца строки), чтобы слова DDL в
 * пояснительном тексте не давали ложных срабатываний статических регулярок.
 */
function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

/** Версии миграций каталога (пакет П1 Этапа 2), в порядке наката. */
const CATALOG_VERSIONS = [
  '0005',
  '0006',
  '0007',
  '0008',
  '0009',
  '0010',
] as const;

/** Возвращает только миграции каталога (0005..0010) в порядке версии. */
async function listCatalogMigrations() {
  const all = await listMigrations();
  return all.filter((m) => (CATALOG_VERSIONS as readonly string[]).includes(m.version));
}

// =============================================================================
// (а) ЮНИТ — файлы миграций каталога. Без БД, всегда зелёные.
// =============================================================================
describe('db/migrations — каталог 0005..0010 (юнит)', () => {
  it('все миграции каталога 0005..0010 существуют и идут по порядку', async () => {
    const catalog = await listCatalogMigrations();
    expect(catalog.map((m) => m.version)).toEqual([...CATALOG_VERSIONS]);
  });

  it('имена миграций каталога соответствуют контракту docs/05', async () => {
    const catalog = await listCatalogMigrations();
    const byVersion = Object.fromEntries(catalog.map((m) => [m.version, m.name]));
    expect(byVersion['0005']).toBe('catalog_extensions_categories');
    expect(byVersion['0006']).toBe('catalog_products');
    expect(byVersion['0007']).toBe('catalog_variants');
    expect(byVersion['0008']).toBe('catalog_attributes');
    expect(byVersion['0009']).toBe('catalog_media');
    expect(byVersion['0010']).toBe('catalog_inventory');
  });

  it('нумерация без пропусков и продолжает Этап 1 (0001..0010 сплошняком)', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    // Версии уникальны и идут сплошной возрастающей последовательностью.
    const expected = versions
      .slice()
      .map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
    // В частности, присутствует весь диапазон каталога.
    for (const v of CATALOG_VERSIONS) {
      expect(versions).toContain(v);
    }
    // parseMigrationName устойчив к номерам каталога.
    expect(parseMigrationName('0010_catalog_inventory.sql')).toEqual({
      version: '0010',
      name: 'catalog_inventory',
    });
  });

  it('каждая миграция каталога идемпотентна и пишет свою версию в schema_migrations', async () => {
    const catalog = await listCatalogMigrations();
    for (const migration of catalog) {
      const sqlText = await readFile(migration.path, 'utf8');
      expect(sqlText).toContain('schema_migrations');
      expect(sqlText).toContain(`'${migration.version}'`);
      expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
    }
  });

  it('все CREATE TABLE/INDEX каталога используют IF NOT EXISTS (идемпотентность)', async () => {
    const catalog = await listCatalogMigrations();
    for (const migration of catalog) {
      const upper = stripSqlComments(
        await readFile(migration.path, 'utf8'),
      ).toUpperCase();
      const creates = upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/g) ?? [];
      const guarded = upper.match(
        /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/g,
      ) ?? [];
      expect(guarded.length, `в ${migration.name} есть незащищённый CREATE`).toBe(
        creates.length,
      );
    }
  });

  it('CREATE EXTENSION (если есть) тоже идемпотентен (IF NOT EXISTS)', async () => {
    const catalog = await listCatalogMigrations();
    for (const migration of catalog) {
      const upper = stripSqlComments(
        await readFile(migration.path, 'utf8'),
      ).toUpperCase();
      const exts = upper.match(/CREATE\s+EXTENSION/g) ?? [];
      const guarded = upper.match(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS/g) ?? [];
      expect(guarded.length).toBe(exts.length);
    }
  });

  it('каждая миграция каталога выдаёт DML-гранты роли admik_app', async () => {
    const catalog = await listCatalogMigrations();
    for (const migration of catalog) {
      const upper = stripSqlComments(
        await readFile(migration.path, 'utf8'),
      ).toUpperCase();
      // Хотя бы один GRANT ... ON ... TO ADMIK_APP на новые таблицы.
      expect(upper, `в ${migration.name} нет GRANT для admik_app`).toMatch(
        /GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+\w+\s+TO\s+ADMIK_APP/,
      );
    }
  });

  it('0005 включает расширение pg_trgm для FTS (docs/05 §2.2)', async () => {
    const catalog = await listCatalogMigrations();
    const ext = catalog.find((m) => m.version === '0005');
    expect(ext).toBeDefined();
    const upper = stripSqlComments(await readFile(ext!.path, 'utf8')).toUpperCase();
    expect(upper).toContain('CREATE EXTENSION IF NOT EXISTS PG_TRGM');
  });

  it('FK-стратегии удаления соответствуют сводной таблице docs/05 §2.7', async () => {
    const catalog = await listCatalogMigrations();
    const text = Object.fromEntries(
      await Promise.all(
        catalog.map(async (m) => [m.version, await readFile(m.path, 'utf8')] as const),
      ),
    );
    // categories.parent_id → RESTRICT
    expect(text['0005']).toMatch(/REFERENCES\s+categories\(id\)\s+ON\s+DELETE\s+RESTRICT/);
    // product_categories → CASCADE на обе стороны
    expect(text['0006']).toMatch(/REFERENCES\s+products\(id\)\s+ON\s+DELETE\s+CASCADE/);
    expect(text['0006']).toMatch(/REFERENCES\s+categories\(id\)\s+ON\s+DELETE\s+CASCADE/);
    // product_attributes.value_id → RESTRICT
    expect(text['0008']).toMatch(/REFERENCES\s+attribute_values\(id\)\s+ON\s+DELETE\s+RESTRICT/);
    // product_media.variant_id → SET NULL
    expect(text['0009']).toMatch(/REFERENCES\s+product_variants\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. В этой среде PostgreSQL нет → skipIf.
//     Применяются ВСЕ миграции (0001..0010) под ролью, способной менять DDL.
// =============================================================================
const INTEGRATION_DB_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — каталог (интеграция)', () => {
  let postgres: any;
  let listMigrationsFn: typeof listMigrations;
  let sql: any;

  function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  /** Применяет ВСЕ миграции по порядку (включая ядро 0001..0004 + каталог). */
  async function applyAllMigrations(): Promise<void> {
    const migrations = await listMigrationsFn();
    const appPassword = process.env.APP_PASSWORD ?? 'app_test_password';
    const migratorPassword =
      process.env.MIGRATOR_PASSWORD ?? 'migrator_test_password';
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

  it('двойной накат всех миграций (ядро + каталог) не падает', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const first = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    await applyAllMigrations();
    const second = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    expect(second).toEqual(first);
    expect(second.map((r: { version: string }) => r.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
    ]);
  });

  it('ключевые таблицы каталога созданы', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const rows = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'categories','products','product_categories','product_variants',
          'attributes','attribute_values','product_attributes',
          'product_media','inventory'
        )
    `;
    const names = rows.map((r: { tablename: string }) => r.tablename).sort();
    expect(names).toEqual([
      'attribute_values',
      'attributes',
      'categories',
      'inventory',
      'product_attributes',
      'product_categories',
      'product_media',
      'product_variants',
      'products',
    ]);
  });

  it('admik_app имеет полный DML на таблицах каталога', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [priv] = await sql`
      SELECT
        has_table_privilege('admik_app','products','SELECT') AS s,
        has_table_privilege('admik_app','products','INSERT') AS i,
        has_table_privilege('admik_app','products','UPDATE') AS u,
        has_table_privilege('admik_app','products','DELETE') AS d
    `;
    expect([priv.s, priv.i, priv.u, priv.d]).toEqual([true, true, true, true]);
  });

  it('FK categories.parent_id = RESTRICT: нельзя удалить категорию с детьми', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [parent] = await sql`
      INSERT INTO categories (slug, name) VALUES ('fk-parent', 'Parent')
      RETURNING id`;
    await sql`
      INSERT INTO categories (parent_id, slug, name)
      VALUES (${parent.id}, 'fk-child', 'Child')`;
    await expect(
      sql`DELETE FROM categories WHERE id = ${parent.id}`,
    ).rejects.toThrow();
    // Чистим: сперва ребёнок, потом родитель.
    await sql`DELETE FROM categories WHERE slug = 'fk-child'`;
    await sql`DELETE FROM categories WHERE id = ${parent.id}`;
  });

  it('FK product_categories = CASCADE: удаление товара чистит связки', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [cat] = await sql`
      INSERT INTO categories (slug, name) VALUES ('cas-cat', 'Cat') RETURNING id`;
    const [prod] = await sql`
      INSERT INTO products (sku, slug, name) VALUES ('CAS-1', 'cas-1', 'P') RETURNING id`;
    await sql`
      INSERT INTO product_categories (product_id, category_id)
      VALUES (${prod.id}, ${cat.id})`;
    await sql`DELETE FROM products WHERE id = ${prod.id}`;
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM product_categories WHERE category_id = ${cat.id}`;
    expect(count).toBe(0);
    await sql`DELETE FROM categories WHERE id = ${cat.id}`;
  });

  it('CHECK inventory: reserved не больше quantity', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [prod] = await sql`
      INSERT INTO products (sku, slug, name) VALUES ('INV-1', 'inv-1', 'P') RETURNING id`;
    await expect(
      sql`INSERT INTO inventory (product_id, quantity, reserved)
          VALUES (${prod.id}, 1, 5)`,
    ).rejects.toThrow();
    await sql`DELETE FROM products WHERE id = ${prod.id}`;
  });
});
