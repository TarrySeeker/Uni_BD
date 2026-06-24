import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Тесты миграции 0029_promo_scope_deactivate_on_empty (волна 5, баг B).
 *
 * Инвариант: scoped-промокод (apply_scope ∈ {category,brand,set}) обязан иметь
 * ≥1 цель promo_targets. Каскадное удаление каталога (ON DELETE CASCADE, 0024)
 * может снести последнюю цель → промокод остаётся активным с пустым набором
 * («мёртвая» акция). Триггер AFTER DELETE гасит такой промокод (is_active=false).
 *
 * (а) ЮНИТ — читают .sql с диска (без БД), проходят ВСЕГДА: наличие 0029,
 *     идемпотентность (CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS +
 *     CREATE TRIGGER), запись в schema_migrations, SECURITY DEFINER + search_path.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — двойной накат + поведение триггера:
 *     удаление единственной цели scoped-промокода → is_active=false.
 */

/** Удаляет SQL-комментарии (-- ... до конца строки) для статического анализа. */
function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

async function read0029(): Promise<string> {
  const all = await listMigrations();
  const m = all.find((x) => x.version === '0029');
  expect(m, 'миграция 0029 должна существовать').toBeDefined();
  return readFile(m!.path, 'utf8');
}

// =============================================================================
// (а) ЮНИТ — файл миграции 0029. Без БД, всегда зелёные.
// =============================================================================
describe('db/migrations — 0029 promo_scope_deactivate_on_empty (юнит)', () => {
  it('0029 существует, имя promo_scope_deactivate_on_empty', async () => {
    const all = await listMigrations();
    const m = all.find((x) => x.version === '0029');
    expect(m).toBeDefined();
    expect(m!.name).toBe('promo_scope_deactivate_on_empty');
  });

  it('идемпотентна: schema_migrations + ON CONFLICT', async () => {
    const sqlText = await read0029();
    expect(sqlText).toContain('schema_migrations');
    expect(sqlText).toContain("'0029'");
    expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
  });

  it('повторно-запускаема: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER', async () => {
    const upper = stripSqlComments(await read0029()).toUpperCase();
    expect(upper).toContain('CREATE OR REPLACE FUNCTION');
    expect(upper).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+\w+\s+ON\s+PROMO_TARGETS/);
    expect(upper).toContain('CREATE TRIGGER');
  });

  it('триггер именно AFTER DELETE FOR EACH ROW ON promo_targets', async () => {
    const upper = stripSqlComments(await read0029()).toUpperCase();
    expect(upper).toMatch(/AFTER\s+DELETE\s+ON\s+PROMO_TARGETS/);
    expect(upper).toContain('FOR EACH ROW');
  });

  it('функция SECURITY DEFINER с зафиксированным search_path (защита от подмены)', async () => {
    const upper = stripSqlComments(await read0029()).toUpperCase();
    expect(upper).toContain('SECURITY DEFINER');
    expect(upper).toMatch(/SET\s+SEARCH_PATH\s*=\s*PUBLIC/);
  });

  it('гасит ТОЛЬКО scoped-промокоды (category/brand/set) без оставшихся целей', async () => {
    const text = await read0029();
    // Условие apply_scope IN (...) присутствует и охватывает три scoped-значения.
    expect(text).toMatch(/apply_scope\s+IN\s*\(\s*'category'\s*,\s*'brand'\s*,\s*'set'\s*\)/);
    // Гасит через is_active=false (не DELETE — история/аудит сохраняются).
    expect(text).toMatch(/SET\s+is_active\s*=\s*false/);
    // Проверка «целей не осталось» (NOT EXISTS по promo_targets).
    expect(text.toUpperCase()).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+PROMO_TARGETS/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. Без DATABASE_URL → skipIf.
//     Накат ВСЕХ миграций под ролью с правами DDL.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)(
  'db/migrations — 0029 promo_scope (интеграция)',
  () => {
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

    it('двойной накат всех миграций (включая 0029) не падает; триггер на месте', async () => {
      await ensureLoaded();
      await applyAllMigrations();
      const first = await sql`SELECT version FROM schema_migrations ORDER BY version`;
      // Повторный накат: CREATE OR REPLACE + DROP TRIGGER IF EXISTS делают миграцию
      // безопасной к повторному запуску.
      await applyAllMigrations();
      const second = await sql`SELECT version FROM schema_migrations ORDER BY version`;
      expect(second).toEqual(first);
      const [{ exists }] = await sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'promo_targets_deactivate_orphan_scope_trg'
            AND NOT tgisinternal
        ) AS exists`;
      expect(exists).toBe(true);
    });

    it('scoped-промокод (category) теряет последнюю цель → is_active=false', async () => {
      await ensureLoaded();
      await applyAllMigrations();

      // Категория-цель.
      const [cat] = await sql`
        INSERT INTO categories (slug, name)
        VALUES (${`promo-scope-test-${Date.now()}`}, 'Promo scope test')
        RETURNING id`;
      // Scoped-промокод (apply_scope='category'), активен.
      const [promo] = await sql`
        INSERT INTO promo_codes (code, kind, value, apply_scope, is_active)
        VALUES (${`PSCAT-${Date.now()}`}, 'percent', 10, 'category', true)
        RETURNING id`;
      // Единственная цель.
      await sql`
        INSERT INTO promo_targets (promo_code_id, target_type, category_id)
        VALUES (${promo.id}, 'category', ${cat.id})`;

      // Каскадное удаление категории сносит единственную цель → триггер гасит акцию.
      await sql`DELETE FROM categories WHERE id = ${cat.id}`;

      const [{ is_active, targets }] = await sql`
        SELECT p.is_active,
               (SELECT count(*)::int FROM promo_targets t WHERE t.promo_code_id = p.id) AS targets
          FROM promo_codes p WHERE p.id = ${promo.id}`;
      expect(targets).toBe(0);
      expect(is_active).toBe(false);

      await sql`DELETE FROM promo_codes WHERE id = ${promo.id}`;
    });

    it('у scoped-промокода с НЕСКОЛЬКИМИ целями удаление одной НЕ гасит акцию', async () => {
      await ensureLoaded();
      await applyAllMigrations();

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const [cat1] = await sql`
        INSERT INTO categories (slug, name) VALUES (${`pst-a-${suffix}`}, 'A') RETURNING id`;
      const [cat2] = await sql`
        INSERT INTO categories (slug, name) VALUES (${`pst-b-${suffix}`}, 'B') RETURNING id`;
      const [promo] = await sql`
        INSERT INTO promo_codes (code, kind, value, apply_scope, is_active)
        VALUES (${`PSMULTI-${suffix}`}, 'percent', 10, 'category', true)
        RETURNING id`;
      await sql`
        INSERT INTO promo_targets (promo_code_id, target_type, category_id)
        VALUES (${promo.id}, 'category', ${cat1.id}), (${promo.id}, 'category', ${cat2.id})`;

      // Удаляем одну из двух категорий — цель ещё остаётся → акция активна.
      await sql`DELETE FROM categories WHERE id = ${cat1.id}`;

      const [{ is_active, targets }] = await sql`
        SELECT p.is_active,
               (SELECT count(*)::int FROM promo_targets t WHERE t.promo_code_id = p.id) AS targets
          FROM promo_codes p WHERE p.id = ${promo.id}`;
      expect(targets).toBe(1);
      expect(is_active).toBe(true);

      await sql`DELETE FROM categories WHERE id = ${cat2.id}`;
      await sql`DELETE FROM promo_codes WHERE id = ${promo.id}`;
    });

    it('cart-промокод (apply_scope=cart) триггер НЕ трогает', async () => {
      await ensureLoaded();
      await applyAllMigrations();

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const [cat] = await sql`
        INSERT INTO categories (slug, name) VALUES (${`pst-cart-${suffix}`}, 'C') RETURNING id`;
      // cart-промокод в норме целей не имеет; на всякий случай создаём искусственную
      // цель и убеждаемся, что её удаление НЕ гасит cart-акцию.
      const [promo] = await sql`
        INSERT INTO promo_codes (code, kind, value, apply_scope, is_active)
        VALUES (${`PSCART-${suffix}`}, 'percent', 10, 'cart', true)
        RETURNING id`;
      await sql`
        INSERT INTO promo_targets (promo_code_id, target_type, category_id)
        VALUES (${promo.id}, 'category', ${cat.id})`;

      await sql`DELETE FROM categories WHERE id = ${cat.id}`;

      const [{ is_active }] = await sql`
        SELECT is_active FROM promo_codes WHERE id = ${promo.id}`;
      expect(is_active).toBe(true);

      await sql`DELETE FROM promo_codes WHERE id = ${promo.id}`;
    });
  },
);
