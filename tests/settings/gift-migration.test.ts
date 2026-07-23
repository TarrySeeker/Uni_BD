import { readFile } from 'node:fs/promises';

import { describe, it, expect } from 'vitest';

import { listMigrations } from '@/lib/db/migrate';

/**
 * Guard-тест миграции 0056 (ТЗ владельца п.11 — автовыпуск кода сертификата).
 *
 * Миграция ОБЯЗАНА быть тривиально-аддитивной: индекс под выборку крона + сид
 * ключа настроек. Никаких новых колонок, никакого изменения CHECK
 * (issue_source='auto' уже разрешён 0054), никакого DDL по products.
 * Сид ОБЯЗАН быть идемпотентным: безусловный UPDATE затёр бы настройки владельца.
 */

/** Срезает `--`-комментарии, чтобы ассерты не ловили слова из пояснений. */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

async function readMigration(version: string) {
  const all = await listMigrations();
  const m = all.find((x) => x.version === version);
  expect(m, `миграция ${version} не найдена`).toBeTruthy();
  const raw = await readFile(m!.path, 'utf8');
  return { meta: m!, raw, sql: stripSqlComments(raw), upper: stripSqlComments(raw).toUpperCase() };
}

describe('db/migrations — 0056_gift_auto_issue', () => {
  it('существует и названа по контракту', async () => {
    const { meta } = await readMigration('0056');
    expect(meta.name).toBe('gift_auto_issue');
  });

  it('нумерация сплошная от 0001 (0056 — последняя занятая)', async () => {
    const versions = (await listMigrations()).map((m) => m.version);
    expect(versions).toEqual(versions.map((_, i) => String(i + 1).padStart(4, '0')));
    expect(versions).toContain('0056');
  });

  it('пишет свою версию в schema_migrations с ON CONFLICT DO NOTHING', async () => {
    const { sql, upper } = await readMigration('0056');
    expect(sql).toContain("'0056'");
    expect(upper).toContain('SCHEMA_MIGRATIONS');
    expect(upper).toContain('ON CONFLICT DO NOTHING');
  });

  it('аддитивна: ни DROP, ни RENAME, ни смены типа, ни SET NOT NULL', async () => {
    const { upper } = await readMigration('0056');
    for (const forbidden of [
      'DROP TABLE',
      'DROP COLUMN',
      'DROP CONSTRAINT',
      'DROP INDEX',
      'DROP DEFAULT',
      'DROP NOT NULL',
      'RENAME',
      'SET NOT NULL',
      'SET DATA TYPE',
      'TRUNCATE',
      'DELETE FROM',
    ]) {
      expect(upper, `запрещено: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('НЕ добавляет колонок и НЕ трогает CHECK (issue_source=auto разрешён ещё 0054)', async () => {
    const { upper } = await readMigration('0056');
    expect(upper).not.toContain('ADD COLUMN');
    expect(upper).not.toContain('ADD CONSTRAINT');
    expect(upper).not.toContain('ISSUE_SOURCE');
  });

  it('никакого DDL по products (каталог не трогаем)', async () => {
    const { upper } = await readMigration('0056');
    expect(upper).not.toMatch(/(ALTER|CREATE|DROP)\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?PRODUCTS/);
    expect(upper).not.toMatch(/UPDATE\s+PRODUCTS/);
    expect(upper).not.toMatch(/INSERT\s+INTO\s+PRODUCTS/);
  });

  it('создаёт частичный индекс orders(paid_at) для оплаченных заказов — под выборку крона', async () => {
    const { upper } = await readMigration('0056');
    expect(upper).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+ORDERS/);
    expect(upper).toMatch(/PAID_AT/);
    expect(upper).toMatch(/WHERE\s+PAYMENT_STATUS\s*=\s*'PAID'/);
  });

  it('все CREATE INDEX защищены IF NOT EXISTS (идемпотентность повторного наката)', async () => {
    const { upper } = await readMigration('0056');
    const creates = upper.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/g) ?? [];
    const guarded = upper.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(creates.length);
  });

  it('сид ключа gift идемпотентен: ON CONFLICT (setting_key) DO NOTHING и НИКАКОГО DO UPDATE', async () => {
    const { sql, upper } = await readMigration('0056');
    expect(upper).toMatch(/INSERT\s+INTO\s+SHOP_SETTINGS/);
    expect(sql).toContain("'gift'");
    expect(upper).toContain('ON CONFLICT (SETTING_KEY) DO NOTHING');
    // Безусловный UPDATE/UPSERT затёр бы политику выпуска, настроенную владельцем.
    expect(upper).not.toContain('DO UPDATE');
    expect(upper).not.toMatch(/UPDATE\s+SHOP_SETTINGS/);
  });

  it('сид кладёт JSON-объект (CHECK jsonb_typeof(value)=object из 0019)', async () => {
    const { sql } = await readMigration('0056');
    const m = sql.match(/'(\{[^']*\})'::jsonb/);
    expect(m, 'ожидается литерал JSONB-объекта в сиде').toBeTruthy();
    expect(() => JSON.parse(m![1])).not.toThrow();
    expect(typeof JSON.parse(m![1])).toBe('object');
  });
});
