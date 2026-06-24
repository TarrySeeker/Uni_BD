import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — миграция 0021_seo_entity_fields.
 *
 * (а) ЮНИТ (без БД, всегда): файл 0021 существует, ALTER ... ADD COLUMN IF NOT
 *     EXISTS на products/categories/brands, запись в schema_migrations ON CONFLICT.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат, колонки на месте.
 */

function stripSqlComments(s: string): string {
  return s.replace(/--[^\n]*/g, '');
}

async function get0021() {
  const all = await listMigrations();
  return all.find((m) => m.version === '0021');
}

describe('db/migrations — 0021_seo_entity_fields (юнит)', () => {
  it('файл 0021 существует с именем seo_entity_fields', async () => {
    const m = await get0021();
    expect(m).toBeDefined();
    expect(m!.name).toBe('seo_entity_fields');
  });

  it('ADD COLUMN всегда с IF NOT EXISTS (идемпотентно)', async () => {
    const m = await get0021();
    const upper = stripSqlComments(await readFile(m!.path, 'utf8')).toUpperCase();
    const adds = upper.match(/ADD\s+COLUMN/g) ?? [];
    const guarded = upper.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/g) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(adds.length);
  });

  it('затрагивает products, categories, brands', async () => {
    const m = await get0021();
    const upper = stripSqlComments(await readFile(m!.path, 'utf8')).toUpperCase();
    expect(upper).toContain('ALTER TABLE PRODUCTS');
    expect(upper).toContain('ALTER TABLE CATEGORIES');
    expect(upper).toContain('ALTER TABLE BRANDS');
  });

  it('добавляет og_title/og_description/og_image_key/canonical_url/noindex', async () => {
    const m = await get0021();
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    for (const col of ['og_title', 'og_description', 'og_image_key', 'canonical_url', 'noindex']) {
      expect(lower, `нет колонки ${col}`).toContain(col);
    }
  });

  it('пишет свою версию в schema_migrations с ON CONFLICT DO NOTHING', async () => {
    const m = await get0021();
    const sqlText = await readFile(m!.path, 'utf8');
    expect(sqlText).toContain('schema_migrations');
    expect(sqlText).toContain("'0021'");
    expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
  });

  it('нумерация: 0021 идёт после 0020 без пропуска', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    expect(versions).toContain('0020');
    expect(versions).toContain('0021');
    const expected = versions.map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. skipIf без DATABASE_URL.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — 0021 (интеграция)', () => {
  let postgres: any;
  let listMigrationsFn: typeof listMigrations;
  let sql: any;

  function quoteLiteral(v: string): string {
    return `'${v.replaceAll("'", "''")}'`;
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
    if (!sql) sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
  }

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('двойной накат не падает; SEO-колонки на месте', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    await applyAllMigrations();
    const rows = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('og_title','og_description','og_image_key','canonical_url','noindex')
        AND table_name IN ('products','categories','brands')
    `;
    const set = new Set(rows.map((r: any) => `${r.table_name}.${r.column_name}`));
    expect(set.has('products.noindex')).toBe(true);
    expect(set.has('categories.canonical_url')).toBe(true);
    expect(set.has('brands.og_image_key')).toBe(true);
  });
});
