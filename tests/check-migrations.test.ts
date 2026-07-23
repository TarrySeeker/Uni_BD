import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * «Тест до кода» для DevOps (Этап 6, пакет 6.4; §6.4, ADR-015).
 *
 * Прогоняет РЕАЛЬНЫЙ bash-скрипт scripts/check-migrations.sh через child_process
 * на фикстурах и на настоящих миграциях. Docker/Postgres НЕ нужны — линтер
 * статический (один проход awk).
 *
 * Контракт линтера:
 *   • деструктивный DDL (DROP COLUMN/TABLE/CONSTRAINT, RENAME, ALTER TYPE,
 *     SET NOT NULL без DEFAULT, удаление enum-значения) → exit ≠ 0;
 *   • аддитивный DDL (ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS,
 *     NOT NULL DEFAULT, SET NOT NULL С DEFAULT, --комментарий) → exit 0;
 *   • реальные db/migrations/0001..0024 → exit 0 (статус-кво аддитивен).
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'check-migrations.sh');

let tmpDir: string;

/** Запускает линтер на одном sql-файле, возвращает { code }. */
function runLint(...files: string[]): { code: number; stdout: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...files], {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Создаёт временный .sql с заданным содержимым, возвращает путь. */
function fixture(name: string, sql: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, sql, 'utf8');
  return p;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admik-miglint-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('check-migrations.sh — запрещённый деструктивный DDL → exit ≠ 0', () => {
  it('DROP COLUMN → fail', () => {
    const f = fixture('bad_drop_column.sql', 'ALTER TABLE x DROP COLUMN y;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('DROP TABLE → fail', () => {
    const f = fixture('bad_drop_table.sql', 'DROP TABLE legacy;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('ALTER ... RENAME → fail', () => {
    const f = fixture('bad_rename.sql', 'ALTER TABLE x RENAME COLUMN a TO b;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('DROP CONSTRAINT → fail', () => {
    const f = fixture('bad_drop_constraint.sql', 'ALTER TABLE x DROP CONSTRAINT x_chk;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('ALTER COLUMN ... TYPE (сужение типа) → fail', () => {
    const f = fixture('bad_type.sql', 'ALTER TABLE x ALTER COLUMN c TYPE varchar(10);\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('ALTER ... TYPE без слова COLUMN (ALTER bar TYPE bigint) → fail', () => {
    // Postgres допускает `ALTER TABLE foo ALTER bar TYPE bigint` без COLUMN —
    // линтер обязан ловить смену типа и в этой форме (правило №7).
    const f = fixture('bad_type_no_column.sql', 'ALTER TABLE foo ALTER bar TYPE bigint;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('SET NOT NULL без DEFAULT → fail', () => {
    const f = fixture('bad_set_nn.sql', 'ALTER TABLE x ALTER COLUMN c SET NOT NULL;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  // --- MAJOR (QA): деструктив, разнесённый по физическим строкам, обходил
  // построчный матч. Линтер обязан матчить ЛОГИЧЕСКИЕ statement'ы. ---

  it('многострочный DROP COLUMN (DROP\\n COLUMN) → fail', () => {
    const f = fixture(
      'bad_drop_column_multiline.sql',
      'ALTER TABLE users DROP\n  COLUMN email;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('многострочный DROP TABLE (DROP\\n TABLE) → fail', () => {
    const f = fixture('bad_drop_table_multiline.sql', 'DROP\n  TABLE legacy;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('многострочный ALTER ... RENAME COLUMN → fail', () => {
    const f = fixture(
      'bad_rename_multiline.sql',
      'ALTER TABLE x\n  RENAME COLUMN a TO b;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  // --- MAJOR (волна 5): DROP INDEX снимает инвариант уникальности/идемпотентности.
  // В Admik уникальность держится на UNIQUE-индексах (orders_idempotency_uniq,
  // orders_number_uniq, uq_tbank_payment_log_idem и т.д.), часть — partial (только
  // индекс, не constraint), поэтому DROP INDEX не ловится правилом DROP CONSTRAINT. ---

  it('DROP INDEX → fail', () => {
    const f = fixture('bad_drop_index.sql', 'DROP INDEX orders_idempotency_uniq;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('DROP INDEX IF EXISTS → fail', () => {
    const f = fixture(
      'bad_drop_index_ine.sql',
      'DROP INDEX IF EXISTS orders_number_uniq;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('DROP INDEX CONCURRENTLY → fail', () => {
    const f = fixture(
      'bad_drop_index_conc.sql',
      'DROP INDEX CONCURRENTLY uq_tbank_payment_log_idem;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('многострочный DROP INDEX (DROP\\n INDEX) → fail', () => {
    const f = fixture(
      'bad_drop_index_multiline.sql',
      'DROP\n  INDEX IF EXISTS customers_email_uniq;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });
});

describe('check-migrations.sh — аддитивный DDL → exit 0', () => {
  it('ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT → ok', () => {
    const f = fixture(
      'ok_add_column.sql',
      "ALTER TABLE x ADD COLUMN IF NOT EXISTS z text NOT NULL DEFAULT '';\n",
    );
    expect(runLint(f).code).toBe(0);
  });

  it('CREATE TABLE IF NOT EXISTS → ok', () => {
    const f = fixture(
      'ok_create_table.sql',
      'CREATE TABLE IF NOT EXISTS t (id uuid PRIMARY KEY, name text NOT NULL);\n',
    );
    expect(runLint(f).code).toBe(0);
  });

  it('SET NOT NULL С DEFAULT в той же инструкции → ok', () => {
    const f = fixture(
      'ok_set_nn_default.sql',
      'ALTER TABLE x ALTER COLUMN c SET DEFAULT 0, ALTER COLUMN c SET NOT NULL;\n',
    );
    expect(runLint(f).code).toBe(0);
  });

  it('--комментарий с DROP COLUMN не считается нарушением → ok', () => {
    const f = fixture(
      'ok_comment.sql',
      '-- этот DROP COLUMN только в комментарии\nCREATE INDEX IF NOT EXISTS i ON t (id);\n',
    );
    expect(runLint(f).code).toBe(0);
  });

  it('ADD CONSTRAINT ... CHECK (расширение) → ok', () => {
    const f = fixture(
      'ok_add_constraint.sql',
      'ALTER TABLE x ADD CONSTRAINT x_price_chk CHECK (price >= 0) NOT VALID;\n',
    );
    expect(runLint(f).code).toBe(0);
  });

  // --- КОНТРОЛЬ: после перехода на statement-уровень нормализации не должно
  // появиться ложных срабатываний на легитимном многострочном SQL. ---

  it('многострочный ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT → ok', () => {
    const f = fixture(
      'ok_add_column_multiline.sql',
      "ALTER TABLE x ADD COLUMN IF NOT EXISTS\n  foo text NOT NULL DEFAULT '';\n",
    );
    expect(runLint(f).code).toBe(0);
  });

  it('DROP COLUMN внутри многострочного --комментария → ok', () => {
    const f = fixture(
      'ok_comment_multiline.sql',
      '-- сначала мы рассматривали DROP\n-- COLUMN email, но отказались\nCREATE INDEX IF NOT EXISTS i ON t (id);\n',
    );
    expect(runLint(f).code).toBe(0);
  });

  // КОНТРОЛЬ к правилу №10 (DROP INDEX): добавление индексов остаётся аддитивным —
  // CREATE INDEX и CREATE UNIQUE INDEX правилом 'drop index' ловиться НЕ должны.
  it('CREATE UNIQUE INDEX IF NOT EXISTS → ok (не путать с DROP INDEX)', () => {
    const f = fixture(
      'ok_create_unique_index.sql',
      'CREATE UNIQUE INDEX IF NOT EXISTS t_email_uniq ON t (email);\n',
    );
    expect(runLint(f).code).toBe(0);
  });
});

describe('check-migrations.sh — carve-out ADR-P1-2 (расширение множества CHECK)', () => {
  // Единственное разрешённое исключение из запрета DROP CONSTRAINT: пара
  // «DROP CONSTRAINT <name>» + «ADD CONSTRAINT <name> CHECK(...)» под явным
  // маркером-комментарием `-- check-migrations:allow-widen-check <proof>`.
  // Тесты доказывают УЗОСТЬ: разрешён ровно этот паттерн, всё прочее — отвергается.

  // Реальный паттерн миграции 0038: расширение orders_payment_provider_chk.
  const WIDEN_0038 =
    '-- check-migrations:allow-widen-check orders_payment_provider_chk superset + paykeeper\n' +
    'DO $$\nBEGIN\n' +
    "  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_payment_provider_chk') THEN\n" +
    '    ALTER TABLE orders DROP CONSTRAINT orders_payment_provider_chk;\n' +
    '  END IF;\n' +
    '  ALTER TABLE orders ADD CONSTRAINT orders_payment_provider_chk\n' +
    "    CHECK (payment_provider IS NULL OR payment_provider IN ('tbank','manual','paykeeper')) NOT VALID;\n" +
    'END $$;\n';

  it('паттерн 0038 (маркер + DROP+ADD того же имени с CHECK) → ok', () => {
    const f = fixture('ok_widen_0038.sql', WIDEN_0038);
    expect(runLint(f).code).toBe(0);
  });

  it('реальный файл db/migrations/0038_orders_provider_paykeeper.sql → ok', () => {
    const p = join(PROJECT_ROOT, 'db', 'migrations', '0038_orders_provider_paykeeper.sql');
    expect(runLint(p).code).toBe(0);
  });

  it('обычный DROP CONSTRAINT БЕЗ маркера → fail (не-widening)', () => {
    const f = fixture('bad_drop_con_no_marker.sql', 'ALTER TABLE x DROP CONSTRAINT x_chk;\n');
    expect(runLint(f).code).not.toBe(0);
  });

  it('маркер есть, но парного ADD ... CHECK нет → fail (только снятие)', () => {
    const f = fixture(
      'bad_widen_no_add.sql',
      '-- check-migrations:allow-widen-check bogus\nALTER TABLE x DROP CONSTRAINT x_chk;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('маркер + DROP/ADD, но имена РАЗНЫЕ → fail (снятое имя не пересоздано)', () => {
    const f = fixture(
      'bad_widen_name_mismatch.sql',
      '-- check-migrations:allow-widen-check proof\n' +
        'ALTER TABLE x DROP CONSTRAINT foo_chk;\n' +
        'ALTER TABLE x ADD CONSTRAINT bar_chk CHECK (y IN (1,2));\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('DROP+ADD того же имени с CHECK, но БЕЗ маркера → fail', () => {
    const f = fixture(
      'bad_widen_no_marker.sql',
      'DO $$ BEGIN ALTER TABLE x DROP CONSTRAINT z_chk;' +
        ' ALTER TABLE x ADD CONSTRAINT z_chk CHECK (y IN (1,2,3)); END $$;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('маркер без непустого <proof> → fail (proof обязателен, owner-signed)', () => {
    const f = fixture(
      'bad_widen_empty_proof.sql',
      '-- check-migrations:allow-widen-check\n' +
        'DO $$ BEGIN ALTER TABLE x DROP CONSTRAINT z_chk;' +
        ' ALTER TABLE x ADD CONSTRAINT z_chk CHECK (y IN (1,2,3)); END $$;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('валидный widen, но в том же файле есть DROP TABLE → fail (carve-out только для CONSTRAINT)', () => {
    const f = fixture(
      'bad_widen_plus_drop_table.sql',
      WIDEN_0038 + 'DROP TABLE legacy;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });

  it('валидный widen, но в том же файле есть DROP COLUMN → fail', () => {
    const f = fixture(
      'bad_widen_plus_drop_column.sql',
      WIDEN_0038 + 'ALTER TABLE x DROP COLUMN y;\n',
    );
    expect(runLint(f).code).not.toBe(0);
  });
});

describe('check-migrations.sh — реальные миграции 0001..0024', () => {
  it('все db/migrations/*.sql аддитивны (exit 0)', () => {
    // Без аргументов линтер берёт все db/migrations/*.sql.
    const { code, stdout } = runLint();
    if (code !== 0) {
      // Если упало — линтер ложно-срабатывает на легитимной миграции; чинить ЛИНТЕР.
      throw new Error(`Линтер ложно сработал на реальных миграциях:\n${stdout}`);
    }
    expect(code).toBe(0);
  });
});
