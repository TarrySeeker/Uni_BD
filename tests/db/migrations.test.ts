import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import {
  listMigrations,
  parseMigrationName,
  sortMigrationNames,
} from '@/lib/db/migrate';

/**
 * Удаляет SQL-комментарии (-- ... до конца строки) перед статическим анализом DDL,
 * чтобы пояснительный текст в комментариях (например, слова UPDATE/DELETE в описании
 * append-only) не давал ложных срабатываний регулярок.
 */
function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

// =============================================================================
// (а) ЮНИТ-тесты — без БД, проходят ВСЕГДА.
//     Покрывают чистую логику разбора и сортировки имён миграций.
// =============================================================================
describe('db/migrate — разбор и сортировка имён (юнит)', () => {
  it('parseMigrationName: NNNN_name.sql → { version, name }', () => {
    expect(parseMigrationName('0001_init_extensions_and_migrations.sql')).toEqual({
      version: '0001',
      name: 'init_extensions_and_migrations',
    });
    expect(parseMigrationName('0042_add_orders.sql')).toEqual({
      version: '0042',
      name: 'add_orders',
    });
  });

  it('parseMigrationName: имя может содержать подчёркивания и цифры', () => {
    expect(parseMigrationName('0010_v2_orders_2024.sql')).toEqual({
      version: '0010',
      name: 'v2_orders_2024',
    });
  });

  it('parseMigrationName: бросает ошибку на некорректном имени', () => {
    expect(() => parseMigrationName('init.sql')).toThrow(/Некорректное имя/);
    expect(() => parseMigrationName('1_init.sql')).toThrow(/Некорректное имя/); // не 4 цифры
    expect(() => parseMigrationName('0001_init.txt')).toThrow(/Некорректное имя/); // не .sql
    expect(() => parseMigrationName('.gitkeep')).toThrow(/Некорректное имя/);
  });

  it('sortMigrationNames: лексикографический порядок по версии, мусор отброшен', () => {
    const input = [
      '0003_rbac.sql',
      '.gitkeep',
      '0001_init.sql',
      'README.md',
      '0010_late.sql',
      '0002_auth.sql',
    ];
    expect(sortMigrationNames(input)).toEqual([
      { version: '0001', name: 'init' },
      { version: '0002', name: 'auth' },
      { version: '0003', name: 'rbac' },
      { version: '0010', name: 'late' },
    ]);
  });

  it('sortMigrationNames: ведущие нули обеспечивают верный порядок (0002 < 0010)', () => {
    const out = sortMigrationNames(['0010_a.sql', '0002_b.sql']);
    expect(out.map((m) => m.version)).toEqual(['0002', '0010']);
  });
});

// =============================================================================
// Проверка реальных файлов миграций Этапа 1 — читает файлы с диска (без БД),
// поэтому может выполняться всегда.
// =============================================================================
describe('db/migrations — файлы Этапа 1 (юнит)', () => {
  it('listMigrations включает 0001..0004 ядра по порядку', async () => {
    const migrations = await listMigrations();
    const core = migrations.filter((m) =>
      ['0001', '0002', '0003', '0004'].includes(m.version),
    );
    expect(core.map((m) => m.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
    ]);
    expect(core[0].name).toBe('init_extensions_and_migrations');
    expect(core[1].name).toBe('auth');
    expect(core[2].name).toBe('rbac');
    expect(core[3].name).toBe('audit');
  });

  it('каждая миграция идемпотентна и пишет в schema_migrations', async () => {
    const migrations = await listMigrations();
    for (const migration of migrations) {
      const sqlText = await readFile(migration.path, 'utf8');
      // Записывает свою версию в журнал применённых миграций.
      expect(sqlText).toContain('schema_migrations');
      expect(sqlText).toContain(`'${migration.version}'`);
      expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
    }
  });

  it('CREATE TABLE/INDEX в миграциях используют IF NOT EXISTS (идемпотентность)', async () => {
    const migrations = await listMigrations();
    for (const migration of migrations) {
      const upper = stripSqlComments(
        await readFile(migration.path, 'utf8'),
      ).toUpperCase();
      // Для каждого CREATE TABLE/INDEX должен присутствовать IF NOT EXISTS.
      const creates = upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/g) ?? [];
      const guarded = upper.match(
        /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/g,
      ) ?? [];
      expect(guarded.length).toBe(creates.length);
    }
  });

  it('audit_log выдаёт app только SELECT/INSERT (append-only, без UPDATE/DELETE)', async () => {
    const migrations = await listMigrations();
    const audit = migrations.find((m) => m.name === 'audit');
    expect(audit).toBeDefined();
    const upper = stripSqlComments(
      await readFile(audit!.path, 'utf8'),
    ).toUpperCase();
    expect(upper).toContain('GRANT SELECT, INSERT ON AUDIT_LOG TO ADMIK_APP');
    // Никакого UPDATE/DELETE на audit_log для app.
    expect(upper).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON AUDIT_LOG TO ADMIK_APP/);
    expect(upper).not.toMatch(/GRANT[^;]*DELETE[^;]*ON AUDIT_LOG TO ADMIK_APP/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИОННЫЕ тесты — нужна живая БД. В этой среде PostgreSQL нет,
//     поэтому describe пропускается при отсутствии DATABASE_URL (skipIf).
//     В CI/проде (с реальной БД под владельцем/migrator) они гоняются.
//
//     ВАЖНО: интеграционные тесты применяют миграции и должны идти под ролью,
//     способной менять DDL (владелец БД / migrator). Они ожидают, что
//     TEST_DATABASE_URL (или DATABASE_URL) указывает на чистую тестовую БД,
//     а пароли ролей переданы как APP_PASSWORD/MIGRATOR_PASSWORD.
// =============================================================================
const INTEGRATION_DB_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — идемпотентность и роли (интеграция)', () => {
  // Ленивая загрузка postgres.js, чтобы юнит-окружение без БД не тянуло драйвер.
  let postgres: any;
  let listMigrationsFn: typeof listMigrations;
  let parseFn: typeof parseMigrationName;

  let sql: any;

  /** Применяет все миграции по порядку, подставляя psql-переменные паролей. */
  async function applyAllMigrations(): Promise<void> {
    const migrations = await listMigrationsFn();
    const appPassword = process.env.APP_PASSWORD ?? 'app_test_password';
    const migratorPassword =
      process.env.MIGRATOR_PASSWORD ?? 'migrator_test_password';

    for (const migration of migrations) {
      let text = await readFile(migration.path, 'utf8');
      // psql-переменные :'APP_PASSWORD' заменяем на безопасно-экранированные литералы.
      text = text
        .replaceAll(":'APP_PASSWORD'", quoteLiteral(appPassword))
        .replaceAll(":'MIGRATOR_PASSWORD'", quoteLiteral(migratorPassword));
      await sql.unsafe(text);
    }
  }

  /** Экранирование строкового литерала для подстановки в DDL (тест-окружение). */
  function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  // Динамический импорт в beforeAll, чтобы файл компилировался без БД.
  // (Vitest допускает top-level imports; для драйвера используем динамический.)
  async function ensureLoaded(): Promise<void> {
    if (!postgres) {
      postgres = (await import('postgres')).default;
      const mod: typeof import('@/lib/db/migrate') = await import('@/lib/db/migrate');
      listMigrationsFn = mod.listMigrations;
      parseFn = mod.parseMigrationName;
    }
    if (!sql) {
      sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
    }
  }

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('двойной накат всех миграций не падает и не меняет данные (идемпотентность)', async () => {
    await ensureLoaded();
    // Используем parseFn, чтобы линтер не считал импорт неиспользуемым в этой ветке.
    expect(parseFn('0001_init.sql').version).toBe('0001');

    await applyAllMigrations();
    // Снимок журнала после первого наката.
    const first = await sql`SELECT version, name FROM schema_migrations ORDER BY version`;

    // Повторный полный накат — должен пройти без ошибок.
    await applyAllMigrations();
    const second = await sql`SELECT version, name FROM schema_migrations ORDER BY version`;

    expect(second).toEqual(first);
    // Ядро 0001..0004 присутствует (каталог 0005+ накатывается тоже, но эта
    // проверка фокусируется на стабильности журнала ядра).
    const coreVersions = second
      .map((r: { version: string }) => r.version)
      .filter((v: string) => ['0001', '0002', '0003', '0004'].includes(v));
    expect(coreVersions).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('роль admik_app существует и НЕ может UPDATE/DELETE audit_log', async () => {
    await ensureLoaded();
    await applyAllMigrations();

    const [appRole] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'admik_app'`;
    expect(appRole).toBeDefined();

    // has_table_privilege для роли app: SELECT/INSERT — да, UPDATE/DELETE — нет.
    const [priv] = await sql`
      SELECT
        has_table_privilege('admik_app', 'audit_log', 'SELECT') AS can_select,
        has_table_privilege('admik_app', 'audit_log', 'INSERT') AS can_insert,
        has_table_privilege('admik_app', 'audit_log', 'UPDATE') AS can_update,
        has_table_privilege('admik_app', 'audit_log', 'DELETE') AS can_delete
    `;
    expect(priv.can_select).toBe(true);
    expect(priv.can_insert).toBe(true);
    expect(priv.can_update).toBe(false);
    expect(priv.can_delete).toBe(false);
  });

  it('роль admik_app не владеет таблицами и не может их DROP/ALTER', async () => {
    await ensureLoaded();
    await applyAllMigrations();

    // app не должен быть владельцем прикладных таблиц (владение = право на DDL).
    const owners = await sql`
      SELECT tablename, tableowner
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('users','sessions','roles','permissions','audit_log')
    `;
    for (const row of owners) {
      expect(row.tableowner).not.toBe('admik_app');
    }
  });
});
