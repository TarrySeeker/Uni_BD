import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations, parseMigrationName } from '@/lib/db/migrate';

/**
 * Тесты пакета 3.A Этапа 3 — миграции заказов 0012…0016 (docs/07 §2).
 *
 * (а) ЮНИТ — читают .sql-файлы с диска (без БД), проходят ВСЕГДА:
 *     наличие 0012..0016, идемпотентность (IF NOT EXISTS на всех CREATE),
 *     запись в schema_migrations, GRANT для admik_app, сплошная нумерация 0001..0016.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — двойной накат ВСЕХ миграций,
 *     создание ключевых таблиц заказов, работа FK.
 */

/** Удаляет SQL-комментарии (-- ... до конца строки) для статических регулярок. */
function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

/** Версии миграций заказов (пакет 3.A), в порядке наката. */
const ORDER_VERSIONS = ['0012', '0013', '0014', '0015', '0016'] as const;

/** Возвращает только миграции заказов (0012..0016) в порядке версии. */
async function listOrderMigrations() {
  const all = await listMigrations();
  return all.filter((m) => (ORDER_VERSIONS as readonly string[]).includes(m.version));
}

// =============================================================================
// (а) ЮНИТ — файлы миграций заказов. Без БД, всегда зелёные.
// =============================================================================
describe('db/migrations — заказы 0012..0016 (юнит)', () => {
  it('все миграции заказов 0012..0016 существуют и идут по порядку', async () => {
    const orders = await listOrderMigrations();
    expect(orders.map((m) => m.version)).toEqual([...ORDER_VERSIONS]);
  });

  it('имена миграций заказов соответствуют контракту docs/07', async () => {
    const orders = await listOrderMigrations();
    const byVersion = Object.fromEntries(orders.map((m) => [m.version, m.name]));
    expect(byVersion['0012']).toBe('orders');
    expect(byVersion['0013']).toBe('customers');
    expect(byVersion['0014']).toBe('promo_codes');
    expect(byVersion['0015']).toBe('promo_redemptions');
    expect(byVersion['0016']).toBe('order_number_counter');
  });

  it('нумерация без пропусков и продолжает каталог (0001..0016 сплошняком)', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    const expected = versions
      .slice()
      .map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
    for (const v of ORDER_VERSIONS) {
      expect(versions).toContain(v);
    }
    // 0016 завершает диапазон ЗАКАЗОВ; цепочку миграций после Этапа 4
    // продолжает СДЭК (0017+), поэтому проверяем присутствие 0016, а не «хвост».
    expect(versions).toContain('0016');
    expect(parseMigrationName('0016_order_number_counter.sql')).toEqual({
      version: '0016',
      name: 'order_number_counter',
    });
  });

  it('каждая миграция заказов идемпотентна и пишет свою версию в schema_migrations', async () => {
    const orders = await listOrderMigrations();
    for (const migration of orders) {
      const sqlText = await readFile(migration.path, 'utf8');
      expect(sqlText).toContain('schema_migrations');
      expect(sqlText).toContain(`'${migration.version}'`);
      expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
    }
  });

  it('все CREATE TABLE/INDEX заказов используют IF NOT EXISTS (идемпотентность)', async () => {
    const orders = await listOrderMigrations();
    for (const migration of orders) {
      const upper = stripSqlComments(await readFile(migration.path, 'utf8')).toUpperCase();
      const creates = upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/g) ?? [];
      const guarded =
        upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/g) ?? [];
      expect(guarded.length, `в ${migration.name} есть незащищённый CREATE`).toBe(
        creates.length,
      );
    }
  });

  it('каждая миграция заказов выдаёт DML-гранты роли admik_app', async () => {
    const orders = await listOrderMigrations();
    for (const migration of orders) {
      const upper = stripSqlComments(await readFile(migration.path, 'utf8')).toUpperCase();
      // Хотя бы один GRANT ... ON ... TO ADMIK_APP на новые таблицы.
      expect(upper, `в ${migration.name} нет GRANT для admik_app`).toMatch(
        /GRANT\s+[\w,\s]+ON\s+\w+\s+TO\s+ADMIK_APP/,
      );
    }
  });

  it('0012/0013/0014/0015 выдают полный DML (S/I/U/D) на свои таблицы', async () => {
    const full = ['0012', '0013', '0014', '0015'];
    const orders = (await listOrderMigrations()).filter((m) => full.includes(m.version));
    for (const migration of orders) {
      const upper = stripSqlComments(await readFile(migration.path, 'utf8')).toUpperCase();
      expect(upper, `в ${migration.name} нет полного DML-гранта`).toMatch(
        /GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+\w+\s+TO\s+ADMIK_APP/,
      );
    }
  });

  it('0016 (нумератор) выдаёт S/I/U без DELETE (счётчик не удаляется)', async () => {
    const counter = (await listOrderMigrations()).find((m) => m.version === '0016');
    expect(counter).toBeDefined();
    const upper = stripSqlComments(await readFile(counter!.path, 'utf8')).toUpperCase();
    expect(upper).toMatch(
      /GRANT\s+SELECT,\s+INSERT,\s+UPDATE\s+ON\s+ORDER_NUMBER_COUNTERS\s+TO\s+ADMIK_APP/,
    );
  });

  it('добавление FK через ALTER идёт идемпотентно (DO-блок + pg_constraint)', async () => {
    const orders = await listOrderMigrations();
    const text = Object.fromEntries(
      await Promise.all(orders.map(async (m) => [m.version, await readFile(m.path, 'utf8')] as const)),
    );
    // FK orders.customer_id добавляется в 0013, orders.promo_code_id — в 0014,
    // т.к. целевые таблицы создаются ПОЗЖЕ 0012 (лексикографический порядок).
    for (const v of ['0013', '0014']) {
      expect(text[v]).toMatch(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint/);
      expect(text[v]).toMatch(/ADD\s+CONSTRAINT/);
    }
    // 0012 НЕ объявляет FK на promo_codes/customers инлайн (они ещё не существуют).
    const orders0012 = stripSqlComments(text['0012']);
    expect(orders0012).not.toMatch(/REFERENCES\s+promo_codes/);
    expect(orders0012).not.toMatch(/REFERENCES\s+customers/);
  });

  it('FK-стратегии удаления соответствуют docs/07 §2', async () => {
    const orders = await listOrderMigrations();
    const text = Object.fromEntries(
      await Promise.all(orders.map(async (m) => [m.version, await readFile(m.path, 'utf8')] as const)),
    );
    // order_items.order_id → CASCADE; product_id/variant_id → SET NULL (снимок остаётся).
    expect(text['0012']).toMatch(/REFERENCES\s+orders\(id\)\s+ON\s+DELETE\s+CASCADE/);
    expect(text['0012']).toMatch(/REFERENCES\s+products\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
    expect(text['0012']).toMatch(/REFERENCES\s+product_variants\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
    // order_status_history.actor_user_id → SET NULL.
    expect(text['0012']).toMatch(/REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
    // orders.customer_id/promo_code_id → SET NULL (через ALTER в 0013/0014).
    expect(text['0013']).toMatch(/REFERENCES\s+customers\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
    expect(text['0014']).toMatch(/REFERENCES\s+promo_codes\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
    // promo_redemptions: оба FK → CASCADE.
    expect(text['0015']).toMatch(/REFERENCES\s+promo_codes\(id\)\s+ON\s+DELETE\s+CASCADE/);
    expect(text['0015']).toMatch(/REFERENCES\s+orders\(id\)\s+ON\s+DELETE\s+CASCADE/);
  });

  it('деньги — numeric(14,2), время — timestamptz, PK — uuid gen_random_uuid', async () => {
    const orders0012 = await readFile(
      (await listOrderMigrations()).find((m) => m.version === '0012')!.path,
      'utf8',
    );
    expect(orders0012).toMatch(/numeric\(14,2\)/);
    expect(orders0012).toMatch(/timestamptz/);
    expect(orders0012).toMatch(/uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  });

  it('orders имеет уникальные индексы номера и idempotency_key (partial)', async () => {
    const orders0012 = await readFile(
      (await listOrderMigrations()).find((m) => m.version === '0012')!.path,
      'utf8',
    );
    expect(orders0012).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS orders_number_uniq/);
    expect(orders0012).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_uniq[\s\S]*WHERE idempotency_key IS NOT NULL/,
    );
  });
});

// =============================================================================
// (а2) ЮНИТ — миграция 0024 промо-механик N×M (Этап 5.2, Пакет 5.P-1).
// =============================================================================
describe('db/migrations — промо N×M 0024 (юнит)', () => {
  async function read0024(): Promise<string> {
    const all = await listMigrations();
    const m = all.find((x) => x.version === '0024');
    expect(m, 'миграция 0024 должна существовать').toBeDefined();
    return readFile(m!.path, 'utf8');
  }

  it('0024 существует, имя promo_mechanics_nxm', async () => {
    const all = await listMigrations();
    const m = all.find((x) => x.version === '0024');
    expect(m).toBeDefined();
    expect(m!.name).toBe('promo_mechanics_nxm');
  });

  it('идемпотентна: schema_migrations + ON CONFLICT + IF NOT EXISTS на CREATE', async () => {
    const sqlText = await read0024();
    expect(sqlText).toContain('schema_migrations');
    expect(sqlText).toContain("'0024'");
    expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
    const upper = stripSqlComments(sqlText).toUpperCase();
    const creates = upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/g) ?? [];
    const guarded =
      upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/g) ?? [];
    expect(guarded.length).toBe(creates.length);
  });

  it('создаёт promo_targets с FK CASCADE и GRANT для admik_app', async () => {
    const sqlText = await read0024();
    const upper = stripSqlComments(sqlText).toUpperCase();
    expect(upper).toContain('CREATE TABLE IF NOT EXISTS PROMO_TARGETS');
    expect(sqlText).toMatch(/REFERENCES\s+promo_codes\(id\)\s+ON\s+DELETE\s+CASCADE/);
    expect(upper).toMatch(/GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+PROMO_TARGETS\s+TO\s+ADMIK_APP/);
  });

  it('добавляет новые колонки promo_codes идемпотентно (ADD COLUMN IF NOT EXISTS)', async () => {
    const sqlText = await read0024();
    const upper = stripSqlComments(sqlText).toUpperCase();
    for (const col of ['APPLY_SCOPE', 'PRIORITY', 'STACKABLE', 'MIN_QTY', 'GIFT_PRODUCT_ID']) {
      expect(upper, `нет ADD COLUMN IF NOT EXISTS ${col}`).toContain(
        `ADD COLUMN IF NOT EXISTS ${col}`,
      );
    }
  });

  it('CHECK apply_scope ограничен whitelist и priority ≥ 0', async () => {
    const sqlText = await read0024();
    expect(sqlText).toMatch(/apply_scope[\s\S]*CHECK[\s\S]*'cart'[\s\S]*'category'[\s\S]*'brand'[\s\S]*'set'/);
    expect(sqlText).toMatch(/priority[\s\S]*CHECK[\s\S]*priority\s*>=\s*0/);
  });

  it('гифт-FK promo_codes → products/variants на месте (задел, ON DELETE SET NULL)', async () => {
    const sqlText = await read0024();
    expect(sqlText).toMatch(/REFERENCES\s+products\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
    expect(sqlText).toMatch(/REFERENCES\s+product_variants\(id\)\s+ON\s+DELETE\s+SET\s+NULL/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. В этой среде PostgreSQL нет → skipIf.
//     Применяются ВСЕ миграции (0001..0016) под ролью, способной менять DDL.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — заказы (интеграция)', () => {
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

  it('двойной накат всех миграций (ядро + каталог + заказы) не падает', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const first = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    await applyAllMigrations();
    const second = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    expect(second).toEqual(first);
    const versions = second.map((r: { version: string }) => r.version);
    for (const v of ORDER_VERSIONS) {
      expect(versions).toContain(v);
    }
  });

  it('ключевые таблицы заказов созданы', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const rows = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'orders','order_items','order_status_history','customers',
          'promo_codes','promo_redemptions','order_number_counters'
        )
    `;
    const names = rows.map((r: { tablename: string }) => r.tablename).sort();
    expect(names).toEqual([
      'customers',
      'order_items',
      'order_number_counters',
      'order_status_history',
      'orders',
      'promo_codes',
      'promo_redemptions',
    ]);
  });

  it('admik_app имеет полный DML на orders', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [priv] = await sql`
      SELECT
        has_table_privilege('admik_app','orders','SELECT') AS s,
        has_table_privilege('admik_app','orders','INSERT') AS i,
        has_table_privilege('admik_app','orders','UPDATE') AS u,
        has_table_privilege('admik_app','orders','DELETE') AS d
    `;
    expect([priv.s, priv.i, priv.u, priv.d]).toEqual([true, true, true, true]);
  });

  it('FK order_items.order_id = CASCADE: удаление заказа чистит позиции', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [order] = await sql`
      INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone)
      VALUES ('FK-TEST-1', 100, 100, 'T', 'fk@example.com', '+70000000000')
      RETURNING id`;
    await sql`
      INSERT INTO order_items (order_id, name_snapshot, sku_snapshot, unit_price, quantity, line_total)
      VALUES (${order.id}, 'P', 'SKU-1', 100, 1, 100)`;
    await sql`DELETE FROM orders WHERE id = ${order.id}`;
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM order_items WHERE order_id = ${order.id}`;
    expect(count).toBe(0);
  });

  it('CHECK orders.status: статус вне whitelist отклоняется', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    await expect(
      sql`INSERT INTO orders (number, status, items_total, grand_total, customer_name, customer_email, customer_phone)
          VALUES ('FK-BADSTATUS', 'bogus', 1, 1, 'T', 'b@example.com', '+70000000000')`,
    ).rejects.toThrow();
  });

  it('UNIQUE orders.number: дубль номера отклоняется', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    await sql`
      INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone)
      VALUES ('UNIQ-1', 1, 1, 'T', 'u@example.com', '+70000000000')`;
    await expect(
      sql`INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone)
          VALUES ('UNIQ-1', 2, 2, 'T', 'u@example.com', '+70000000000')`,
    ).rejects.toThrow();
    await sql`DELETE FROM orders WHERE number = 'UNIQ-1'`;
  });

  it('нумератор: атомарный инкремент выдаёт последовательные значения', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const scope = `test-${Date.now()}`;
    const next = async () => {
      const [{ last_value }] = await sql`
        INSERT INTO order_number_counters (scope, last_value) VALUES (${scope}, 1)
        ON CONFLICT (scope) DO UPDATE SET last_value = order_number_counters.last_value + 1
        RETURNING last_value`;
      return Number(last_value);
    };
    expect(await next()).toBe(1);
    expect(await next()).toBe(2);
    expect(await next()).toBe(3);
    await sql`DELETE FROM order_number_counters WHERE scope = ${scope}`;
  });
});
