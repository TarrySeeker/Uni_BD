import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { applyAllMigrations } from '@/tests/helpers/apply-migrations';

/**
 * TDD-контроль общего хелпера накатки миграций (Дефект B, Категория A).
 *
 * Копипаст-варианты applyAllMigrations() в интеграционных тестах гнали миграции
 * через postgres.js `sql.unsafe(fileText)`. Миграция 0001 содержит psql-метакоманду
 * `\gexec` и psql-переменные :'APP_PASSWORD'/:'MIGRATOR_PASSWORD' — postgres.js их
 * не исполняет и падал с «syntax error at or near backslash», из-за чего НИ ОДНА
 * миграция не накатывалась и валились все интеграционные ассерты.
 *
 * Общий хелпер делегирует накат pgshim-клиенту psql (тот же, что использует
 * scripts/init-shop.sh), который корректно исполняет \gexec и подстановку :'VAR'.
 *
 * КРАСНЫЙ (до реализации хелпера): импорт не резолвится / накат падает на 0001.
 * ЗЕЛЁНЫЙ: накат проходит, 0001 отработал (schema_migrations + обе роли).
 *
 * skipIf без БД → канонический прогон без DATABASE_URL этот файл пропускает.
 */
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('tests/helpers/apply-migrations (интеграция)', () => {
  let sql: ReturnType<typeof postgres> | undefined;

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('накатывает все миграции (0001 c \\gexec) без «syntax error at or near backslash»', async () => {
    await expect(applyAllMigrations()).resolves.toBeUndefined();
  });

  it('0001 отработал: schema_migrations 0001 + роли admik_app/admik_migrator', async () => {
    await applyAllMigrations();
    sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });

    const migRows = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = '0001'
    `;
    expect(migRows[0]?.version).toBe('0001');

    const roleRows = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('admik_app', 'admik_migrator')
      ORDER BY rolname
    `;
    expect(roleRows.map((r) => r.rolname)).toEqual(['admik_app', 'admik_migrator']);
  });
});
