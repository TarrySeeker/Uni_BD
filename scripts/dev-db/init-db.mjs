// ============================================================================
// Node-раннер инициализации БД БЕЗ Docker и БЕЗ psql/sudo.
// ============================================================================
// Повторяет логику scripts/init-shop.sh (bootstrap → миграции → seed прав/ролей),
// но через postgres.js (зависимость `postgres` уже в проекте) — для окружений, где
// НЕТ клиентских бинарников psql/pg_isready и НЕТ Docker (напр. автоматизированная
// сессия ассистента на «голом» хосте). Боевой путь на VPS остаётся штатным:
// docker compose + scripts/init-shop.sh — этот раннер его НЕ заменяет, а дополняет.
//
// Обходит psql-измы миграции 0001 (`\gexec`, `:'VAR'`) в самом раннере: повторяет
// её эффект (расширения + роли через DO-блоки + journal) под суперпользователем и
// пропускает 0001 в цикле — иммутабельная миграция НЕ меняется.
//
// Запуск (после подъёма локального сервера — см. start.mjs):
//   PGHOST=127.0.0.1 PGPORT=5442 PGUSER=postgres PGDATABASE=admik \
//   APP_PASSWORD=app-local MIGRATOR_PASSWORD=migrator-local \
//   node scripts/dev-db/init-db.mjs           # FRESH=1 — снести и пересоздать БД
// ============================================================================
import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // корень репозитория
const MIGRATIONS_DIR = join(ROOT, 'db', 'migrations');
const SEED_DIR = join(ROOT, 'db', 'seed');

const HOST = process.env.PGHOST || '127.0.0.1';
const PORT = Number(process.env.PGPORT || 5442); // нейтральный dev-порт (не 5432/5433)
const DB = process.env.PGDATABASE || 'admik';
const SUPERUSER = process.env.PGUSER || 'postgres';
const APP_PASSWORD = process.env.APP_PASSWORD || 'app-local';
const MIGRATOR_PASSWORD = process.env.MIGRATOR_PASSWORD || 'migrator-local';

// PGPASSWORD (опц.): пусто → trust-auth (локальный embedded-pg с --auth=trust);
// задано → password-auth (embedded-postgres npm по умолчанию).
const SUPER_PASSWORD = process.env.PGPASSWORD || undefined;
const base = { host: HOST, port: PORT, database: DB, max: 1, onnotice: () => {} };
const su = postgres({ ...base, user: SUPERUSER, password: SUPER_PASSWORD });
const migrator = postgres({ ...base, user: 'admik_migrator', password: MIGRATOR_PASSWORD });

function lit(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

async function ensureDatabase() {
  const admin = postgres({ host: HOST, port: PORT, database: 'postgres', user: SUPERUSER, password: SUPER_PASSWORD, max: 1, onnotice: () => {} });
  try {
    if (process.env.FRESH === '1') {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      console.log(`  ✔ база данных ${DB} удалена (FRESH=1)`);
    }
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname=${DB}`;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${DB} OWNER ${SUPERUSER}`);
      console.log(`  ✔ база данных ${DB} создана`);
    } else {
      console.log(`  • база данных ${DB} уже существует`);
    }
  } finally {
    await admin.end();
  }
}

async function bootstrap() {
  // Эквивалент bootstrap-шага init-shop.sh + полный эффект миграции 0001, чтобы
  // дальше можно было пропустить 0001 (в ней psql-only \gexec/:'var').
  await su.unsafe(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='admik_migrator') THEN
        EXECUTE format('CREATE ROLE admik_migrator LOGIN PASSWORD %L', ${lit(MIGRATOR_PASSWORD)});
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='admik_app') THEN
        EXECUTE format('CREATE ROLE admik_app LOGIN PASSWORD %L', ${lit(APP_PASSWORD)});
      END IF;
    END $$;
    GRANT ALL   ON SCHEMA public TO admik_migrator;
    GRANT USAGE ON SCHEMA public TO admik_app;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT, INSERT, UPDATE ON schema_migrations TO admik_migrator;
    GRANT SELECT ON schema_migrations TO admik_app;
    INSERT INTO schema_migrations (version, name)
      VALUES ('0001', 'init_extensions_and_migrations') ON CONFLICT DO NOTHING;
  `).simple();
  console.log('  ✔ bootstrap (расширения, роли admik_migrator/admik_app, journal, эффект 0001)');
}

async function runMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  let applied = 0;
  for (const f of files) {
    if (f.startsWith('0001_')) {
      console.log(`  • ${f} — покрыта bootstrap, пропуск`);
      continue;
    }
    const content = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    // DDL-миграции идём под admik_migrator (least-privilege). CREATE EXTENSION/ROLE
    // снимаем — уже созданы суперпользователем в bootstrap.
    const sql = content
      .replace(/^[ \t]*CREATE\s+EXTENSION[^;]*;[ \t]*$/gim, '-- CREATE EXTENSION — уже создано в bootstrap')
      .replace(/^[ \t]*CREATE\s+ROLE[^;]*;[ \t]*$/gim, '-- CREATE ROLE — уже создано в bootstrap');
    try {
      await migrator.unsafe(sql).simple();
      console.log(`  ✔ ${f} (под admik_migrator)`);
      applied++;
    } catch (e) {
      console.error(`  ✗ ОШИБКА в ${f} (под admik_migrator): ${e.message}`);
      throw e;
    }
  }
  console.log(`  ✔ миграции применены: ${applied} (+0001 bootstrap)`);
}

async function runSeeds() {
  for (const seed of ['permissions.sql', 'roles.sql']) {
    const content = await readFile(join(SEED_DIR, seed), 'utf8');
    await su.unsafe(content).simple();
    console.log(`  ✔ seed ${seed}`);
  }
}

async function main() {
  console.log(`=== init-db (dev, postgres.js, без Docker/psql) → ${SUPERUSER}@${HOST}:${PORT}/${DB} ===`);
  await ensureDatabase();
  await bootstrap();
  await runMigrations();
  await runSeeds();
  const [{ count }] = await su`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'`;
  console.log(`\n=== ГОТОВО: таблиц в public = ${count} ===`);
  await su.end();
  await migrator.end();
}

main().catch(async (e) => {
  console.error('init-db FAILED:', e);
  try { await su.end(); await migrator.end(); } catch { /* ignore */ }
  process.exit(1);
});
