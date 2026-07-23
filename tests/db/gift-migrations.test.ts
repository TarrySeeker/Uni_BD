import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Миграции под-шага 4a (docs/24 §5): 0039_gift_certificates,
 * 0040_gift_certificate_redemptions, 0041_orders_gift_columns.
 *
 * (а) ЮНИТ (без БД): файлы существуют, аддитивны/идемпотентны (IF NOT EXISTS,
 *     CHECK через DO-блок, GRANT admik_app, schema_migrations ON CONFLICT).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат, таблицы/колонки на месте.
 */

function stripSqlComments(s: string): string {
  // Убираем комментарии и схлопываем выравнивающие пробелы (колонки в CREATE TABLE
  // выровнены множественными пробелами) — сравнения ведём по одному пробелу.
  return s.replace(/--[^\n]*/g, '').replace(/[ \t]+/g, ' ');
}
async function getMigration(version: string) {
  return (await listMigrations()).find((m) => m.version === version);
}
/** Схлопывает ЛЮБОЙ whitespace (включая переводы строк) — для многострочного DDL. */
function flat(s: string): string {
  return s.replace(/\s+/g, ' ');
}
async function body(version: string): Promise<string> {
  const m = await getMigration(version);
  return stripSqlComments(await readFile(m!.path, 'utf8'));
}

describe('db/migrations — 0039_gift_certificates (юнит)', () => {
  it('файл 0039 существует с именем gift_certificates', async () => {
    const m = await getMigration('0039');
    expect(m).toBeDefined();
    expect(m!.name).toBe('gift_certificates');
  });

  it('CREATE TABLE IF NOT EXISTS + уникальный код', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('create table if not exists gift_certificates');
    expect(lower).toContain('create unique index if not exists gift_certificates_code_uniq');
  });

  it('баланс: initial_amount > 0, spent_total default 0, инвариант 0 <= spent <= initial', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('initial_amount');
    expect(lower).toContain('check (initial_amount > 0)');
    expect(lower).toContain('spent_total');
    expect(lower).toContain('spent_total >= 0 and spent_total <= initial_amount');
  });

  it('status CHECK active/depleted/disabled/expired', async () => {
    const lower = (await body('0039')).toLowerCase();
    for (const s of ['active', 'depleted', 'disabled', 'expired']) {
      expect(lower).toContain(`'${s}'`);
    }
  });

  it('i18n: description/terms + translations jsonb с CHECK jsonb_typeof=object (DO-блок)', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('description');
    expect(lower).toContain('terms');
    expect(lower).toContain("translations jsonb not null default '{}'::jsonb");
    expect(lower).toContain("jsonb_typeof(translations) = 'object'");
    expect(lower).toContain('pg_constraint'); // идемпотентный DO-блок
  });

  it('GRANT admik_app + schema_migrations ON CONFLICT', async () => {
    const lower = (await body('0039')).toLowerCase();
    expect(lower).toContain('to admik_app');
    expect(lower).toContain("insert into schema_migrations");
    expect(lower).toContain('on conflict do nothing');
  });
});

describe('db/migrations — 0040_gift_certificate_redemptions (юнит)', () => {
  it('файл 0040 существует', async () => {
    expect((await getMigration('0040'))!.name).toBe('gift_certificate_redemptions');
  });

  it('леджер: FK на сертификат и заказ, amount > 0, UNIQUE(cert,order) для идемпотентности', async () => {
    const lower = (await body('0040')).toLowerCase();
    expect(lower).toContain('create table if not exists gift_certificate_redemptions');
    expect(lower).toContain('references gift_certificates(id) on delete cascade');
    expect(lower).toContain('references orders(id)');
    expect(lower).toContain('check (amount > 0)');
    expect(lower).toContain('create unique index if not exists gift_cert_redemptions_order_uniq');
    expect(lower).toContain('reversed_at'); // задел под release/рефанд
  });
});

describe('db/migrations — 0041_orders_gift_columns (юнит)', () => {
  it('файл 0041 существует', async () => {
    expect((await getMigration('0041'))!.name).toBe('orders_gift_columns');
  });

  it('аддитивные колонки orders: gift_certificate_id (FK), gift_discount_total (>=0)', async () => {
    const lower = (await body('0041')).toLowerCase();
    expect(lower).toContain('alter table orders add column if not exists gift_certificate_id uuid');
    expect(lower).toContain('alter table orders add column if not exists gift_discount_total numeric(14,2) not null default 0');
    expect(lower).toContain('orders_gift_discount_nonneg_chk');
    expect(lower).toContain('references gift_certificates(id) on delete set null');
  });
});

describe('db/migrations — 0054_gift_certificates_people (юнит)', () => {
  it('файл 0054 существует с именем gift_certificates_people', async () => {
    const m = await getMigration('0054');
    expect(m).toBeDefined();
    expect(m!.name).toBe('gift_certificates_people');
  });

  it('стороны сделки: снимки покупателя и получателя + ссылка на клиента (все аддитивно)', async () => {
    const lower = (await body('0054')).toLowerCase();
    for (const col of [
      'purchaser_name text',
      'purchaser_email citext',
      'purchaser_phone text',
      'purchaser_customer_id uuid',
      'recipient_name text',
      'recipient_email citext',
      'recipient_phone text',
    ]) {
      expect(lower).toContain(`alter table gift_certificates add column if not exists ${col}`);
    }
    // Снимок, а НЕ только FK: колонок-снимков хватает без customers.
    expect(lower).toContain('references customers(id) on delete set null');
  });

  it('происхождение выпуска: issued_order_id / issued_order_item_id с FK ON DELETE SET NULL', async () => {
    const lower = (await body('0054')).toLowerCase();
    expect(lower).toContain('alter table gift_certificates add column if not exists issued_order_id uuid');
    expect(lower).toContain('alter table gift_certificates add column if not exists issued_order_item_id uuid');
    expect(lower).toContain('references orders(id) on delete set null');
    expect(lower).toContain('references order_items(id) on delete set null');
    // Семантическая ловушка: НЕ переиспользуем orders.gift_certificate_id
    // («сертификат ПОТРАЧЕН на заказ») под «выпущен по заказу».
    expect(lower).not.toContain('alter table orders');
  });

  it('источник выпуска — text + CHECK, НЕ enum, и набор включает автовыпуск волны 4', async () => {
    const lower = (await body('0054')).toLowerCase();
    expect(flat(lower)).toContain('add column if not exists issue_source text');
    expect(lower).toContain("issue_source in ('manual','order','auto')");
    // Антипаттерн: ENUM (ALTER TYPE ... ADD VALUE неаддитивен).
    expect(lower).not.toContain('create type');
    expect(lower).not.toContain('alter type');
  });

  it('идемпотентность автовыпуска: ЧАСТИЧНЫЙ UNIQUE по issued_order_item_id', async () => {
    const lower = (await body('0054')).toLowerCase();
    expect(flat(lower)).toContain('create unique index if not exists gift_certificates_issued_item_uniq');
    expect(flat(lower)).toMatch(
      /create unique index if not exists gift_certificates_issued_item_uniq on gift_certificates \(issued_order_item_id\) where issued_order_item_id is not null/,
    );
  });

  it('аддитивность: ни одной NOT NULL-колонки, CHECK/FK через DO-блок, запись версии', async () => {
    const raw = await body('0054');
    const lower = raw.toLowerCase();
    // Все новые колонки NULL-able — 2 строки стенда и 288 заказов не ломаются.
    const addColumns = lower.match(/add column if not exists [^;]+/g) ?? [];
    expect(addColumns.length).toBeGreaterThanOrEqual(10);
    for (const stmt of addColumns) {
      expect(stmt).not.toContain('not null');
    }
    expect(lower).toContain('pg_constraint'); // идемпотентный DO-блок
    expect(lower).toContain("insert into schema_migrations");
    expect(lower).toContain("'0054'");
    expect(lower).toContain('on conflict do nothing');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — двойной накат (идемпотентность) + структура.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations 0039-0041 (интеграция)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  afterAll(async () => {
    if (closeSql) await closeSql();
  });

  it('таблицы и колонки существуют после наката', async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;

    const [t] = await sql<{ a: string | null; b: string | null }[]>`
      SELECT to_regclass('public.gift_certificates')::text AS a,
             to_regclass('public.gift_certificate_redemptions')::text AS b
    `;
    expect(t!.a).toBe('gift_certificates');
    expect(t!.b).toBe('gift_certificate_redemptions');

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name IN ('gift_certificate_id', 'gift_discount_total')
    `;
    expect(cols.map((c) => c.column_name).sort()).toEqual(['gift_certificate_id', 'gift_discount_total']);

    const [reg] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM schema_migrations WHERE version IN ('0039','0040','0041','0054')
    `;
    expect(reg!.n).toBe('4');

    // 0054: стороны сделки и происхождение выпуска на gift_certificates.
    const giftCols = await sql<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'gift_certificates'
        AND column_name IN ('purchaser_name','purchaser_email','purchaser_phone',
                            'purchaser_customer_id','recipient_name','recipient_email',
                            'recipient_phone','issued_order_id','issued_order_item_id','issue_source')
    `;
    expect(giftCols).toHaveLength(10);
    expect(giftCols.every((c) => c.is_nullable === 'YES')).toBe(true);

    // Частичный UNIQUE по позиции заказа — защита автовыпуска волны 4 от дублей.
    const [idx] = await sql<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
      WHERE indexname = 'gift_certificates_issued_item_uniq'
    `;
    expect(idx!.def).toMatch(/UNIQUE/i);
    expect(idx!.def).toMatch(/WHERE .*issued_order_item_id IS NOT NULL/i);
  });
});
