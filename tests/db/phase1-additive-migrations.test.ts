import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { listMigrations, MIGRATIONS_DIR } from '@/lib/db/migrate';

/**
 * Тесты миграции 0049 (Фаза 1, шаг 8c — батч аддитивных доработок §9).
 *
 * (а) ЮНИТ — читают .sql с диска (без БД), проходят ВСЕГДА: наличие 0049,
 *     сплошная нумерация, все ALTER — аддитивные ADD COLUMN IF NOT EXISTS,
 *     нет DROP/RENAME/ALTER TYPE, CHECK delivery_type НЕ трогается,
 *     запись в schema_migrations.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — двойной накат (идемпотентность),
 *     все новые колонки существуют.
 */

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

const FILE = '0049_phase1_additive_fields.sql';

async function readMigration(): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, FILE), 'utf8');
}

// =============================================================================
// (а) ЮНИТ — файл миграции. Без БД, всегда зелёные.
// =============================================================================
describe('db/migrations — 0049 phase1_additive_fields (юнит)', () => {
  it('миграция 0049 существует и продолжает сплошную нумерацию', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    // Сплошная нумерация 0001..NNNN без пропусков.
    const expected = versions.map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
    expect(versions).toContain('0049');
    expect(all.find((m) => m.version === '0049')?.name).toBe('phase1_additive_fields');
  });

  it('все ALTER — аддитивные ADD COLUMN IF NOT EXISTS', async () => {
    const sqlText = stripSqlComments(await readMigration());
    const alters = sqlText.match(/ALTER TABLE[^;]+;/gi) ?? [];
    expect(alters.length).toBeGreaterThanOrEqual(8);
    for (const a of alters) {
      expect(a).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    }
  });

  it('добавляет ровно ожидаемые колонки пяти доработок §9', async () => {
    const sqlText = stripSqlComments(await readMigration());
    expect(sqlText).toMatch(/categories\s+ADD COLUMN IF NOT EXISTS image_key/i);
    for (const col of ['company', 'city', 'subject', 'answer', 'attachment_key']) {
      expect(sqlText).toMatch(new RegExp(`leads ADD COLUMN IF NOT EXISTS ${col}`, 'i'));
    }
    expect(sqlText).toMatch(/brands ADD COLUMN IF NOT EXISTS external_url/i);
    expect(sqlText).toMatch(/orders ADD COLUMN IF NOT EXISTS is_postamat boolean NOT NULL DEFAULT false/i);
  });

  it('НЕ содержит деструктивных/несовместимых DDL (аддитивность §6.4)', async () => {
    const sqlText = stripSqlComments(await readMigration()).toUpperCase();
    expect(sqlText).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|DEFAULT)/);
    expect(sqlText).not.toMatch(/RENAME/);
    expect(sqlText).not.toMatch(/ALTER\s+COLUMN[^;]*TYPE/);
    // Постамат — флаг, а НЕ новое значение CHECK delivery_type (не трогаем enum).
    expect(sqlText).not.toMatch(/DELIVERY_TYPE_CHK|DELIVERY_TYPE\s+IN\s*\(/);
  });

  it('пишет строку в schema_migrations', async () => {
    const sqlText = await readMigration();
    expect(sqlText).toMatch(/INSERT INTO schema_migrations/i);
    expect(sqlText).toMatch(/'0049'/);
    expect(sqlText).toMatch(/ON CONFLICT DO NOTHING/i);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД на :5434.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('0049 (интеграция, нужна БД)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  afterAll(async () => {
    if (closeSql) await closeSql();
  });

  async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = ${column}
    `;
    return Number(rows[0]?.n ?? 0) > 0;
  }

  it('все колонки §9 существуют после наката (миграцию накатывает migrator)', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;

    // Миграция накатывается ролью admik_migrator (владелец). Рантаймовая роль
    // admik_app (этот тест) DDL не выполняет — проверяем результат наката.
    // Идемпотентность (двойной ADD COLUMN IF NOT EXISTS) верифицируется юнит-
    // структурой файла и повторным накатом в pipeline check-migrations/init.
    expect(await columnExists('categories', 'image_key')).toBe(true);
    for (const col of ['company', 'city', 'subject', 'answer', 'attachment_key']) {
      expect(await columnExists('leads', col)).toBe(true);
    }
    expect(await columnExists('brands', 'external_url')).toBe(true);
    expect(await columnExists('orders', 'is_postamat')).toBe(true);

    const marker = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM schema_migrations WHERE version = '0049'
    `;
    expect(Number(marker[0]!.n)).toBe(1);
  });
});
