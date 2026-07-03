// ============================================================================
// Поднять эфемерную локальную БД PostgreSQL БЕЗ Docker и БЕЗ sudo.
// ============================================================================
// Использует npm-пакет `embedded-postgres` (devDependency) — он скачивает нативный
// бинарь PostgreSQL при `pnpm install` (в node_modules, не в системе). Порт/каталог
// данных — из env. Данные эфемерны (каталог gitignored). После подъёма инициализируй
// схему: `PGPASSWORD=<пароль> node scripts/dev-db/init-db.mjs`.
//
// Для окружений, где НЕТ Docker и НЕТ клиентского psql (напр. автоматизированная
// сессия ассистента на «голом» хосте). Боевой путь — docker compose (см. README).
//
// Запуск (держит сервер, пока жив процесс; для фонового — запусти отсоединённо):
//   PGPORT=5442 node scripts/dev-db/start.mjs
// ============================================================================
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGDATA || join(HERE, 'data'); // gitignored (см. .gitignore)
const PORT = Number(process.env.PGPORT || 5442); // нейтральный dev-порт (не 5432/5433)
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || 'postgres';

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true, // данные переживают перезапуск процесса
});

if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) {
  console.log(`initdb → ${DATA_DIR}`);
  await pg.initialise();
}
await pg.start();
console.log(`✔ PostgreSQL: 127.0.0.1:${PORT} (superuser ${USER})`);
console.log(`  Инициализация схемы:  PGHOST=127.0.0.1 PGPORT=${PORT} PGUSER=${USER} PGPASSWORD=${PASSWORD} node scripts/dev-db/init-db.mjs`);

async function shutdown() {
  try { await pg.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
