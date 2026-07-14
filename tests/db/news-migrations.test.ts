import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Миграция шага 5 (docs/24 §3): 0042_news.
 *
 * (а) ЮНИТ (без БД): файл существует, аддитивен/идемпотентен (IF NOT EXISTS,
 *     CHECK jsonb_typeof через DO-блок, GRANT admik_app, schema_migrations ON CONFLICT).
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

describe('db/migrations — 0042_news (юнит)', () => {
  it('файл 0042 существует с именем news', async () => {
    const m = await getMigration('0042');
    expect(m).toBeDefined();
    expect(m!.name).toBe('news');
  });

  it('CREATE TABLE IF NOT EXISTS + уникальный slug', async () => {
    const lower = (await body('0042')).toLowerCase();
    expect(lower).toContain('create table if not exists news');
    expect(lower).toContain('create unique index if not exists news_slug_uniq');
  });

  it('status CHECK draft/published/archived', async () => {
    const lower = (await body('0042')).toLowerCase();
    for (const s of ['draft', 'published', 'archived']) {
      expect(lower).toContain(`'${s}'`);
    }
    expect(lower).toContain('status text');
  });

  it('ключевые поля порта b_news присутствуют', async () => {
    const lower = (await body('0042')).toLowerCase();
    for (const col of [
      'slug', 'title', 'group_label', 'excerpt', 'body', 'cover_image_key',
      'published_at', 'sort_order', 'seo_title', 'og_image_key', 'noindex',
    ]) {
      expect(lower).toContain(col);
    }
  });

  it('i18n: translations jsonb с CHECK jsonb_typeof=object (DO-блок)', async () => {
    const lower = (await body('0042')).toLowerCase();
    expect(lower).toContain("translations jsonb not null default '{}'::jsonb");
    expect(lower).toContain("jsonb_typeof(translations) = 'object'");
    expect(lower).toContain('news_translations_obj_chk');
  });

  it('GRANT admik_app + schema_migrations ON CONFLICT', async () => {
    const lower = (await body('0042')).toLowerCase();
    expect(lower).toContain('grant select, insert, update, delete on news to admik_app');
    expect(lower).toContain("insert into schema_migrations");
    expect(lower).toContain('on conflict do nothing');
  });

  it('аддитивна: без DROP/RENAME/ALTER TYPE', async () => {
    const lower = (await body('0042')).toLowerCase();
    expect(lower).not.toContain('drop table');
    expect(lower).not.toContain('drop column');
    expect(lower).not.toMatch(/rename\s+(to|column|constraint)/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД (двойной накат идемпотентен).
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — 0042_news (интеграция)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  afterAll(async () => {
    if (closeSql) await closeSql();
  });

  it('таблица news и колонки существуют', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'news'
    `;
    const names = new Set(cols.map((c) => c.column_name));
    for (const c of ['id', 'slug', 'title', 'status', 'translations', 'published_at']) {
      expect(names.has(c)).toBe(true);
    }
  });

  it('CHECK translations = object отвергает не-объект', async () => {
    await expect(
      sql`INSERT INTO news (slug, title, translations)
          VALUES (${'chk-' + Math.random().toString(36).slice(2)}, 'x', '[]'::jsonb)`,
    ).rejects.toThrow();
  });
});
