import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Миграция шага 8b (§9): 0048_product_blocks (порт b_work_block).
 *
 * (а) ЮНИТ (без БД): файл существует, аддитивен/идемпотентен (IF NOT EXISTS,
 *     CHECK через DO-блоки, FK product CASCADE + author designers SET NULL,
 *     GRANT admik_app, schema_migrations ON CONFLICT, без деструктивного DDL).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): таблица и FK на месте.
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

describe('db/migrations — 0048_product_blocks (юнит)', () => {
  it('файл 0048 существует с именем product_blocks', async () => {
    const m = await getMigration('0048');
    expect(m).toBeDefined();
    expect(m!.name).toBe('product_blocks');
  });

  it('CREATE TABLE IF NOT EXISTS product_blocks + индекс product+sort', async () => {
    const lower = (await body('0048')).toLowerCase();
    expect(lower).toContain('create table if not exists product_blocks');
    expect(lower).toContain('create index if not exists product_blocks_product_sort_idx');
  });

  it('ключевые поля порта b_work_block присутствуют', async () => {
    const lower = (await body('0048')).toLowerCase();
    for (const col of [
      'product_id', 'type', 'title', 'blockquot', 'author_designer_id',
      'body', 'image_key', 'tabs', 'sort', 'translations',
    ]) {
      expect(lower).toContain(col);
    }
  });

  it('type CHECK на нормализованный enum секций', async () => {
    const lower = (await body('0048')).toLowerCase();
    expect(lower).toContain("check (type in ('text','quote','tabs','image'))");
  });

  it('FK product_id → products ON DELETE CASCADE (DO-блок, идемпотентно)', async () => {
    const lower = (await body('0048')).toLowerCase();
    expect(lower).toContain('product_blocks_product_id_fkey');
    expect(lower).toContain('references products(id) on delete cascade');
  });

  it('FK author_designer_id → designers ON DELETE SET NULL', async () => {
    const lower = (await body('0048')).toLowerCase();
    expect(lower).toContain('product_blocks_author_designer_id_fkey');
    expect(lower).toContain('references designers(id) on delete set null');
  });

  it('i18n: translations jsonb-объект + tabs jsonb-массив (CHECK через DO-блок)', async () => {
    const lower = (await body('0048')).toLowerCase();
    expect(lower).toContain("translations jsonb not null default '{}'::jsonb");
    expect(lower).toContain("jsonb_typeof(translations) = 'object'");
    expect(lower).toContain("tabs jsonb not null default '[]'::jsonb");
    expect(lower).toContain("jsonb_typeof(tabs) = 'array'");
  });

  it('GRANT admik_app + schema_migrations ON CONFLICT', async () => {
    const lower = (await body('0048')).toLowerCase();
    expect(lower).toContain('grant select, insert, update, delete on product_blocks to admik_app');
    expect(lower).toContain('insert into schema_migrations');
    expect(lower).toContain('on conflict do nothing');
  });

  it('без запрещённых деструктивных DDL (drop/rename/alter type)', async () => {
    const lower = (await body('0048')).toLowerCase();
    expect(lower).not.toMatch(/drop\s+table/);
    expect(lower).not.toMatch(/drop\s+column/);
    expect(lower).not.toMatch(/\brename\b/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — 0048 (интеграция, нужна БД)', () => {
  it('таблица product_blocks и FK CASCADE/SET NULL существуют', async () => {
    const { sql, closeSql } = await import('@/lib/db/client');
    try {
      const t = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'product_blocks'
        ) AS exists
      `;
      expect(t[0]!.exists).toBe(true);

      const fks = await sql<{ conname: string; confdeltype: string }[]>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = 'product_blocks'::regclass AND contype = 'f'
      `;
      const byName = new Map(fks.map((f) => [f.conname, f.confdeltype]));
      // c = CASCADE, n = SET NULL.
      expect(byName.get('product_blocks_product_id_fkey')).toBe('c');
      expect(byName.get('product_blocks_author_designer_id_fkey')).toBe('n');
    } finally {
      await closeSql();
    }
  });
});
