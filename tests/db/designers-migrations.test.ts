import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Миграция шага 8a (§9, ADR §4.4): 0047_designers.
 *
 * (а) ЮНИТ (без БД): файл существует, аддитивен/идемпотентен (IF NOT EXISTS,
 *     CHECK jsonb_typeof через DO-блок, FK ON DELETE SET NULL, GRANT admik_app,
 *     schema_migrations ON CONFLICT).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат идемпотентен, таблица
 *     designers и колонка products.designer_id на месте.
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

describe('db/migrations — 0047_designers (юнит)', () => {
  it('файл 0047 существует с именем designers', async () => {
    const m = await getMigration('0047');
    expect(m).toBeDefined();
    expect(m!.name).toBe('designers');
  });

  it('CREATE TABLE IF NOT EXISTS designers + уникальный slug', async () => {
    const lower = (await body('0047')).toLowerCase();
    expect(lower).toContain('create table if not exists designers');
    expect(lower).toContain('create unique index if not exists designers_slug_uniq');
  });

  it('ключевые поля порта b_stuff присутствуют', async () => {
    const lower = (await body('0047')).toLowerCase();
    for (const col of [
      'slug', 'name', 'country', 'description', 'image_key', 'page_image_key',
      'video_url', 'socials', 'work_count', 'is_active', 'sort', 'translations',
    ]) {
      expect(lower).toContain(col);
    }
  });

  it('i18n: translations jsonb с CHECK jsonb_typeof=object (DO-блок)', async () => {
    const lower = (await body('0047')).toLowerCase();
    expect(lower).toContain("translations jsonb not null default '{}'::jsonb");
    expect(lower).toContain("jsonb_typeof(translations) = 'object'");
    expect(lower).toContain('designers_translations_obj_chk');
  });

  it('socials jsonb с CHECK jsonb_typeof=object', async () => {
    const lower = (await body('0047')).toLowerCase();
    expect(lower).toContain("socials jsonb not null default '{}'::jsonb");
    expect(lower).toContain('designers_socials_obj_chk');
  });

  it('products.designer_id nullable FK ON DELETE SET NULL', async () => {
    const lower = (await body('0047')).toLowerCase();
    expect(lower).toContain('add column if not exists designer_id uuid references designers(id) on delete set null');
    expect(lower).toContain('create index if not exists products_designer_idx');
  });

  it('GRANT admik_app + schema_migrations ON CONFLICT', async () => {
    const lower = (await body('0047')).toLowerCase();
    expect(lower).toContain('grant select, insert, update, delete on designers to admik_app');
    expect(lower).toContain("insert into schema_migrations");
    expect(lower).toContain('on conflict do nothing');
  });

  it('без запрещённых деструктивных DDL (drop/rename/alter type)', async () => {
    const lower = (await body('0047')).toLowerCase();
    expect(lower).not.toMatch(/drop\s+table/);
    expect(lower).not.toMatch(/drop\s+column/);
    expect(lower).not.toMatch(/\brename\b/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — 0047 (интеграция, нужна БД)', () => {
  it('таблица designers и колонка products.designer_id существуют', async () => {
    const { sql, closeSql } = await import('@/lib/db/client');
    try {
      const t = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'designers'
        ) AS exists
      `;
      expect(t[0]!.exists).toBe(true);

      const c = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'products' AND column_name = 'designer_id'
        ) AS exists
      `;
      expect(c[0]!.exists).toBe(true);
    } finally {
      await closeSql();
    }
  });
});
