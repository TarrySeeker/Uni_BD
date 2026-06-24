import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listMigrations } from '@/lib/db/migrate';

/**
 * Интеграционные тесты пакета 5.C-2 (docs/11 §5.1.6) — требуют живую БД.
 * skipIf без DATABASE_URL → в окружении без БД пропускаются (не падают).
 *
 * Проверяют против реальной БД:
 *  - двойной накат миграций без ошибки;
 *  - publishCmsPage пишет ревизию транзакционно + проставляет published_at;
 *  - upsertCmsSection ON CONFLICT(page_id, section_key) обновляет, а не дублирует;
 *  - reorderCmsSections атомарно меняет display_order;
 *  - DELETE страницы каскадно сносит секции и ревизии (FK CASCADE);
 *  - CHECK размера content отвергает гигантский JSONB-блок.
 *
 * Мутации идут НАПРЯМУЮ к таблицам через postgres.js (как в репозитории),
 * повторяя SQL Server Actions — actions.ts требует Next-сессию/RBAC и не
 * вызывается из юнит-окружения. Логика санитайзера/валидации покрыта юнит-тестами.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('cms — мутации против БД (интеграция)', () => {
  let postgres: any;
  let sql: any;

  function quoteLiteral(v: string): string {
    return `'${v.replaceAll("'", "''")}'`;
  }

  async function applyAllMigrations(): Promise<void> {
    const migrations = await listMigrations();
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

  async function freshPage(slug: string): Promise<string> {
    const rows = await sql`
      INSERT INTO cms_pages (slug, title, status)
      VALUES (${slug}, ${'T ' + slug}, 'draft')
      ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
      RETURNING id
    `;
    return rows[0].id as string;
  }

  beforeAll(async () => {
    postgres = (await import('postgres')).default;
    sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
    await applyAllMigrations();
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM cms_pages WHERE slug LIKE 'it-cms-%'`.catch(() => {});
      await sql.end({ timeout: 5 });
    }
  });

  it('двойной накат миграций не падает', async () => {
    await applyAllMigrations();
    await applyAllMigrations();
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('cms_pages','cms_page_sections','cms_page_revisions')
    `;
    expect(rows.length).toBe(3);
  });

  it('публикация: published_at проставляется и ревизия пишется транзакционно (revision = max+1)', async () => {
    const id = await freshPage('it-cms-publish');

    // эмуляция publishCmsPage: транзакционно status+published_at + снимок-ревизия.
    await sql.begin(async (tx: any) => {
      await tx`
        UPDATE cms_pages
           SET status = 'published',
               published_at = COALESCE(published_at, now()),
               updated_at = now()
         WHERE id = ${id}
      `;
      const maxRow = await tx`
        SELECT COALESCE(MAX(revision), 0) AS m FROM cms_page_revisions WHERE page_id = ${id}
      `;
      const next = Number(maxRow[0].m) + 1;
      await tx`
        INSERT INTO cms_page_revisions (page_id, revision, snapshot)
        VALUES (${id}, ${next}, ${tx.json({ slug: 'it-cms-publish' })})
      `;
    });

    const page = await sql`SELECT status, published_at FROM cms_pages WHERE id = ${id}`;
    expect(page[0].status).toBe('published');
    expect(page[0].published_at).not.toBeNull();

    const revs = await sql`SELECT revision FROM cms_page_revisions WHERE page_id = ${id} ORDER BY revision`;
    expect(revs.length).toBe(1);
    expect(Number(revs[0].revision)).toBe(1);
  });

  it('upsertCmsSection: ON CONFLICT(page_id, section_key) обновляет, не дублирует', async () => {
    const id = await freshPage('it-cms-upsert');
    const upsert = async (html: string) =>
      sql`
        INSERT INTO cms_page_sections (page_id, section_key, type, content, display_order, enabled)
        VALUES (${id}, 'intro', 'text', ${sql.json({ type: 'text', html })}, 0, true)
        ON CONFLICT (page_id, section_key) DO UPDATE
          SET content = EXCLUDED.content, updated_at = now()
      `;
    await upsert('<p>v1</p>');
    await upsert('<p>v2</p>');
    const rows = await sql`SELECT content FROM cms_page_sections WHERE page_id = ${id}`;
    expect(rows.length).toBe(1);
    expect((rows[0].content as { html: string }).html).toBe('<p>v2</p>');
  });

  it('reorderCmsSections: атомарно меняет display_order', async () => {
    const id = await freshPage('it-cms-reorder');
    const ins = async (key: string, order: number) => {
      const r = await sql`
        INSERT INTO cms_page_sections (page_id, section_key, type, content, display_order)
        VALUES (${id}, ${key}, 'text', ${sql.json({ type: 'text', html: '<p>x</p>' })}, ${order})
        RETURNING id
      `;
      return r[0].id as string;
    };
    const a = await ins('a', 0);
    const b = await ins('b', 1);

    await sql.begin(async (tx: any) => {
      await tx`UPDATE cms_page_sections SET display_order = 1, updated_at = now() WHERE id = ${a} AND page_id = ${id}`;
      await tx`UPDATE cms_page_sections SET display_order = 0, updated_at = now() WHERE id = ${b} AND page_id = ${id}`;
    });

    const rows = await sql`SELECT section_key FROM cms_page_sections WHERE page_id = ${id} ORDER BY display_order`;
    expect(rows.map((r: any) => r.section_key)).toEqual(['b', 'a']);
  });

  it('DELETE страницы каскадно сносит секции и ревизии (FK CASCADE)', async () => {
    const id = await freshPage('it-cms-cascade');
    await sql`
      INSERT INTO cms_page_sections (page_id, section_key, type, content)
      VALUES (${id}, 'x', 'text', ${sql.json({ type: 'text', html: '<p>x</p>' })})
    `;
    await sql`INSERT INTO cms_page_revisions (page_id, revision, snapshot) VALUES (${id}, 1, ${sql.json({})})`;
    await sql`DELETE FROM cms_pages WHERE id = ${id}`;
    const sec = await sql`SELECT 1 FROM cms_page_sections WHERE page_id = ${id}`;
    const rev = await sql`SELECT 1 FROM cms_page_revisions WHERE page_id = ${id}`;
    expect(sec.length).toBe(0);
    expect(rev.length).toBe(0);
  });

  it('CHECK размера content отвергает гигантский JSONB-блок (> 64KiB)', async () => {
    const id = await freshPage('it-cms-size');
    const huge = 'x'.repeat(70000);
    let threw = false;
    try {
      await sql`
        INSERT INTO cms_page_sections (page_id, section_key, type, content)
        VALUES (${id}, 'big', 'text', ${sql.json({ type: 'text', html: huge })})
      `;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
