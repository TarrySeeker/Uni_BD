import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listMigrations } from '@/lib/db/migrate';
import { mapCmsPage } from '@/lib/cms/repository';

/**
 * C18 — OG-текст CMS-страницы (og_title/og_description) доходит до БД.
 *
 * (а) ЮНИТ (без БД): миграция 0033 аддитивно добавляет колонки og_title/
 *     og_description в cms_pages (ADD COLUMN IF NOT EXISTS) и записывает версию.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): зеркалит SQL Server Action
 *     updateCmsPage — CASE WHEN data.ogX !== undefined: явное значение пишется,
 *     undefined сохраняет прежнее, '' (→ trim()||undefined в форме отсутствует;
 *     здесь проверяем сам контракт CASE WHEN на уровне SQL). Мутации идут напрямую
 *     к таблице через postgres.js (actions.ts требует Next-сессию/RBAC), повторяя
 *     SQL экшена — образец tests/cms/integration.test.ts.
 */

function stripSqlComments(s: string): string {
  return s.replace(/--[^\n]*/g, '');
}

async function getMigration(version: string) {
  const all = await listMigrations();
  return all.find((m) => m.version === version);
}

describe('db/migrations — 0033_cms_pages_og_text (юнит)', () => {
  it('файл 0033 существует с именем cms_pages_og_text', async () => {
    const m = await getMigration('0033');
    expect(m).toBeDefined();
    expect(m!.name).toBe('cms_pages_og_text');
  });

  it('аддитивно: ADD COLUMN IF NOT EXISTS og_title/og_description', async () => {
    const m = await getMigration('0033');
    const lower = stripSqlComments(await readFile(m!.path, 'utf8')).toLowerCase();
    expect(lower).toContain('add column if not exists og_title');
    expect(lower).toContain('add column if not exists og_description');
    expect(lower).toContain('alter table cms_pages');
    // Деструктивного DDL быть не должно.
    expect(lower).not.toContain('drop column');
  });

  it('пишет версию 0033 в schema_migrations с ON CONFLICT DO NOTHING', async () => {
    const m = await getMigration('0033');
    const sqlText = await readFile(m!.path, 'utf8');
    expect(sqlText).toContain('schema_migrations');
    expect(sqlText).toContain("'0033'");
    expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
  });
});

describe('cms/repository — mapCmsPage отдаёт ogTitle/ogDescription (C18)', () => {
  it('маппит og_title/og_description → ogTitle/ogDescription', () => {
    const p = mapCmsPage({
      id: 'p-1',
      slug: 'about',
      title: 'О компании',
      status: 'draft',
      published_at: null,
      seo_title: null,
      seo_description: null,
      og_title: 'OG T',
      og_description: 'OG D',
      og_image_url: null,
      canonical_url: null,
      noindex: false,
      sitemap_priority: null,
      sitemap_changefreq: null,
      created_by: null,
      updated_by: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(p.ogTitle).toBe('OG T');
    expect(p.ogDescription).toBe('OG D');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. skipIf без DATABASE_URL (на CI/стенде гоняется).
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('cms — og-текст пишется в БД (интеграция)', () => {
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
      INSERT INTO cms_pages (slug, title, status, og_title, og_description)
      VALUES (${slug}, ${'T ' + slug}, 'draft', 'исходный OG-title', 'исходный OG-desc')
      ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
      RETURNING id
    `;
    return rows[0].id as string;
  }

  /** Зеркало updateCmsPage: CASE WHEN ${ogX !== undefined}. */
  async function updateOg(
    id: string,
    ogTitle: string | null | undefined,
    ogDescription: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    const rows = await sql`
      UPDATE cms_pages SET
        og_title       = CASE WHEN ${ogTitle !== undefined}
                              THEN ${ogTitle ?? null} ELSE og_title END,
        og_description = CASE WHEN ${ogDescription !== undefined}
                              THEN ${ogDescription ?? null} ELSE og_description END,
        updated_at     = now()
      WHERE id = ${id}
      RETURNING og_title, og_description
    `;
    return rows[0];
  }

  beforeAll(async () => {
    postgres = (await import('postgres')).default;
    sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
    await applyAllMigrations();
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM cms_pages WHERE slug LIKE 'it-cms-og-%'`.catch(() => {});
      await sql.end({ timeout: 5 });
    }
  });

  it('двойной накат миграций добавляет колонки og_title/og_description', async () => {
    await applyAllMigrations();
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'cms_pages'
        AND column_name IN ('og_title','og_description')
    `;
    expect(new Set(cols.map((c: any) => c.column_name))).toEqual(
      new Set(['og_title', 'og_description']),
    );
  });

  it('явное значение пишется; undefined сохраняет прежнее; null очищает', async () => {
    const id = await freshPage('it-cms-og-update');

    // 1) Явные значения — пишутся.
    let row = await updateOg(id, 'новый OG-title', 'новый OG-desc');
    expect(mapCmsPage({ ...stub(id), ...row }).ogTitle).toBe('новый OG-title');
    expect(row.og_description).toBe('новый OG-desc');

    // 2) undefined — поле не трогаем (прежнее значение сохраняется).
    row = await updateOg(id, undefined, undefined);
    expect(row.og_title).toBe('новый OG-title');
    expect(row.og_description).toBe('новый OG-desc');

    // 3) null — очистка поля.
    row = await updateOg(id, null, null);
    expect(row.og_title).toBeNull();
    expect(row.og_description).toBeNull();
  });

  /** Заглушка row для прогона через mapCmsPage (проверяем доменный маппинг). */
  function stub(id: string): Record<string, unknown> {
    return {
      id,
      slug: 'it-cms-og-update',
      title: 'T',
      status: 'draft',
      published_at: null,
      seo_title: null,
      seo_description: null,
      og_image_url: null,
      canonical_url: null,
      noindex: false,
      sitemap_priority: null,
      sitemap_changefreq: null,
      created_by: null,
      updated_by: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }
});
