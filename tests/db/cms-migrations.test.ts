import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Тесты пакета 5.C-1 (docs/11 §5.1.6) — миграции 0022_cms_pages / 0023_cms_page_sections.
 *
 * (а) ЮНИТ (без БД, всегда): файлы существуют, сплошная нумерация от 0001,
 *     CREATE TABLE/INDEX IF NOT EXISTS, GRANT TO admik_app, запись в
 *     schema_migrations ON CONFLICT, CHECK размера content идемпотентно (DO-блок).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат, таблицы на месте.
 */

function stripSqlComments(s: string): string {
  return s.replace(/--[^\n]*/g, '');
}

async function getMigration(version: string) {
  const all = await listMigrations();
  return all.find((m) => m.version === version);
}

describe('db/migrations — 0022_cms_pages (юнит)', () => {
  it('файл 0022 существует с именем cms_pages', async () => {
    const m = await getMigration('0022');
    expect(m).toBeDefined();
    expect(m!.name).toBe('cms_pages');
  });

  it('CREATE TABLE cms_pages с IF NOT EXISTS (идемпотентно)', async () => {
    const m = await getMigration('0022');
    const upper = stripSqlComments(await readFile(m!.path, 'utf8')).toUpperCase();
    expect(upper).toContain('CREATE TABLE IF NOT EXISTS CMS_PAGES');
  });

  it('UNIQUE INDEX cms_pages_slug_uniq с IF NOT EXISTS', async () => {
    const m = await getMigration('0022');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain('create unique index if not exists cms_pages_slug_uniq');
  });

  it('все CREATE INDEX — с IF NOT EXISTS', async () => {
    const m = await getMigration('0022');
    const upper = stripSqlComments(await readFile(m!.path, 'utf8')).toUpperCase();
    const idx = upper.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/g) ?? [];
    const guarded = upper.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/g) ?? [];
    expect(idx.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(idx.length);
  });

  it('status — триада draft/published/archived через CHECK', async () => {
    const m = await getMigration('0022');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain("'draft'");
    expect(lower).toContain("'published'");
    expect(lower).toContain("'archived'");
    expect(lower).toContain('check');
  });

  it('содержит SEO/sitemap-поля прямо в CREATE TABLE', async () => {
    const m = await getMigration('0022');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    for (const col of [
      'seo_title',
      'seo_description',
      'og_image_url',
      'canonical_url',
      'noindex',
      'sitemap_priority',
      'sitemap_changefreq',
      'published_at',
    ]) {
      expect(lower, `нет колонки ${col}`).toContain(col);
    }
  });

  it('created_by/updated_by — FK на users ON DELETE SET NULL', async () => {
    const m = await getMigration('0022');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain('created_by');
    expect(lower).toContain('updated_by');
    expect(lower).toContain('references users(id) on delete set null');
  });

  it('выдаёт GRANT ... TO admik_app', async () => {
    const m = await getMigration('0022');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain('grant');
    expect(lower).toContain('to admik_app');
  });

  it('пишет версию в schema_migrations с ON CONFLICT DO NOTHING', async () => {
    const m = await getMigration('0022');
    const sqlText = await readFile(m!.path, 'utf8');
    expect(sqlText).toContain('schema_migrations');
    expect(sqlText).toContain("'0022'");
    expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
  });

  it('опциональный seed демо-страницы — через ON CONFLICT DO NOTHING (если есть)', async () => {
    const m = await getMigration('0022');
    const sqlText = await readFile(m!.path, 'utf8');
    // Если присутствует INSERT INTO cms_pages — он должен быть идемпотентен.
    if (/insert\s+into\s+cms_pages/i.test(sqlText)) {
      const inserts = sqlText.match(/INSERT\s+INTO\s+cms_pages/gi) ?? [];
      const guarded = sqlText.match(/INSERT\s+INTO\s+cms_pages[\s\S]*?ON\s+CONFLICT\s+DO\s+NOTHING/gi) ?? [];
      expect(guarded.length).toBe(inserts.length);
    }
  });
});

describe('db/migrations — 0023_cms_page_sections (юнит)', () => {
  it('файл 0023 существует с именем cms_page_sections', async () => {
    const m = await getMigration('0023');
    expect(m).toBeDefined();
    expect(m!.name).toBe('cms_page_sections');
  });

  it('CREATE TABLE cms_page_sections с IF NOT EXISTS', async () => {
    const m = await getMigration('0023');
    const upper = stripSqlComments(await readFile(m!.path, 'utf8')).toUpperCase();
    expect(upper).toContain('CREATE TABLE IF NOT EXISTS CMS_PAGE_SECTIONS');
  });

  it('page_id — FK на cms_pages ON DELETE CASCADE', async () => {
    const m = await getMigration('0023');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain('references cms_pages(id) on delete cascade');
  });

  it('UNIQUE (page_id, section_key)', async () => {
    const m = await getMigration('0023');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8'))
      .toLowerCase()
      .replace(/\s+/g, ' ');
    expect(lower).toContain('unique (page_id, section_key)');
  });

  it('type — дискриминатор с CHECK по семи типам секций', async () => {
    const m = await getMigration('0023');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    for (const t of ['hero', 'text', 'banner', 'products_grid', 'faq', 'cta', 'gallery']) {
      expect(lower, `нет типа ${t} в CHECK`).toContain(`'${t}'`);
    }
  });

  it('INDEX(page_id, display_order) с IF NOT EXISTS', async () => {
    const m = await getMigration('0023');
    const upper = stripSqlComments(await readFile(m!.path, 'utf8')).toUpperCase();
    const idx = upper.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/g) ?? [];
    const guarded = upper.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/g) ?? [];
    expect(idx.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(idx.length);
    const lower = stripSqlComments(await readFile(m!.path, 'utf8'))
      .toLowerCase()
      .replace(/\s+/g, ' ');
    expect(lower).toContain('(page_id, display_order)');
  });

  it('CHECK размера content (pg_column_size < 65536) через DO-блок + pg_constraint', async () => {
    const m = await getMigration('0023');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain('pg_column_size');
    expect(lower).toContain('65536');
    expect(lower).toContain('do $$');
    expect(lower).toContain('pg_constraint');
  });

  it('выдаёт GRANT ... TO admik_app', async () => {
    const m = await getMigration('0023');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain('grant');
    expect(lower).toContain('to admik_app');
  });

  it('пишет версию в schema_migrations с ON CONFLICT DO NOTHING', async () => {
    const m = await getMigration('0023');
    const sqlText = await readFile(m!.path, 'utf8');
    expect(sqlText).toContain('schema_migrations');
    expect(sqlText).toContain("'0023'");
    expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
  });
});

describe('db/migrations — сплошная нумерация (юнит)', () => {
  it('0022 и 0023 идут без пропусков от 0001', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    expect(versions).toContain('0021');
    expect(versions).toContain('0022');
    expect(versions).toContain('0023');
    const expected = versions.map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. skipIf без DATABASE_URL.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — 0022/0023 (интеграция)', () => {
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

  it('двойной накат не падает; таблицы cms_pages/cms_page_sections на месте', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    await applyAllMigrations();
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('cms_pages','cms_page_sections')
    `;
    const set = new Set(rows.map((r: any) => r.table_name));
    expect(set.has('cms_pages')).toBe(true);
    expect(set.has('cms_page_sections')).toBe(true);
  });
});
