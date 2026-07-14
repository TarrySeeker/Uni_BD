import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { listMigrations } from '@/lib/db/migrate';

/**
 * Общий тест-хелпер накатки миграций для интеграционного тира.
 *
 * ПОЧЕМУ shell-out в pgshim, а не in-process postgres.js:
 *   Ранее каждый интеграционный файл имел копипаст-копию applyAllMigrations(),
 *   которая читала db/migrations/*.sql и гнала их через postgres.js
 *   `sql.unsafe(fileText)`. Миграция 0001 содержит psql-МЕТАКОМАНДУ `\gexec` и
 *   psql-переменные :'APP_PASSWORD'/:'MIGRATOR_PASSWORD'. postgres.js не исполняет
 *   метакоманды psql → «syntax error at or near backslash» на первой же миграции →
 *   НИ ОДНА миграция не накатывалась и валились все интеграционные ассерты.
 *
 *   Этот хелпер делегирует накат pgshim-клиенту psql — ровно тому, что использует
 *   продакшн-раннер scripts/init-shop.sh. pgshim корректно исполняет \gexec,
 *   подстановку :'VAR', dollar-quote/строки/комментарии. Никакой подстановки
 *   переменных на стороне JS (в отличие от копипасты) — файлы передаются как есть.
 *
 * ПРИВИЛЕГИИ: накат создаёт роли (CREATE ROLE) и выдаёт GRANT — это может только
 *   суперпользователь. admik_app (DATABASE_URL) на это прав не имеет. Поэтому
 *   дочерний psql коннектится СУПЕРПОЛЬЗОВАТЕЛЕМ через unix-сокет /tmp (trust),
 *   без пароля. Тестовый `sql` (admik_app по DATABASE_URL) остаётся для ассертов.
 *
 * ПРОИЗВОДИТЕЛЬНОСТЬ: тесты зовут applyAllMigrations в КАЖДОМ it (иные — дважды,
 *   «двойной накат»). Per-file спавн 49 процессов = ~3.7s на накат → двойной ~7.4s
 *   выбивал дефолтный vitest-таймаут 5s. Поэтому весь SQL конкатенируется и
 *   скармливается ОДНОМУ спавну pgshim через stdin (~0.47s на накат). Семантика
 *   идентична: pgshim в одной сессии автокоммитит каждое утверждение по порядку.
 *
 * ИДЕМПОТЕНТНОСТЬ: миграции безопасны к повторному накату (CREATE ... IF NOT EXISTS,
 *   DO-блоки, \gexec WHERE NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING). На
 *   предынициализированной dev-БД повторный накат = no-op. Глобального memo НЕТ
 *   намеренно — тесты «двойного наката» рассчитывают на реальный повторный накат.
 *
 * Все параметры соединения — с env-оверрайдами и дефолтами под локальный devdb.
 */

/** Путь к psql-клиенту (pgshim). Переопределяется ADMIK_TEST_PSQL. */
const DEFAULT_PSQL = '/home/coder/TS/carre/carre-devdb/pgshim/psql';

/** Резолвинг соединения суперпользователя и путей — из env с дефолтами devdb. */
export interface SuperuserPsqlEnv {
  /** Путь к бинарю/шиму psql. */
  psql: string;
  /** PGHOST для дочернего psql (unix-сокет /tmp даёт trust-доступ суперпользователю). */
  host: string;
  /** PGPORT — из DATABASE_URL, оверрайд PGPORT. */
  port: string;
  /** PGUSER — суперпользователь (postgres), оверрайд PGUSER. */
  user: string;
  /** PGDATABASE — из DATABASE_URL, оверрайд PGDATABASE. */
  database: string;
  /** Пароль роли admik_app для :'APP_PASSWORD' (на инициализированной БД — no-op). */
  appPassword: string;
  /** Пароль роли admik_migrator для :'MIGRATOR_PASSWORD'. */
  migratorPassword: string;
}

/**
 * Парсит port + database из DATABASE_URL (или TEST_DATABASE_URL) и собирает
 * параметры соединения суперпользователя. host/user берутся под суперпользователя
 * отдельно (не из URL, который идёт под admik_app), с env-оверрайдами.
 */
export function resolveSuperuserPsqlEnv(): SuperuserPsqlEnv {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  let urlPort = '5434';
  let urlDatabase = 'carre';
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.port) urlPort = parsed.port;
      const db = parsed.pathname.replace(/^\//, '');
      if (db) urlDatabase = db;
    } catch {
      // невалидный URL — остаёмся на дефолтах devdb.
    }
  }

  return {
    psql: process.env.ADMIK_TEST_PSQL ?? DEFAULT_PSQL,
    host: process.env.PGHOST ?? '/tmp',
    port: process.env.PGPORT ?? urlPort,
    user: process.env.PGUSER ?? 'postgres',
    database: process.env.PGDATABASE ?? urlDatabase,
    appPassword: process.env.APP_PASSWORD ?? 'app_test_password',
    migratorPassword: process.env.MIGRATOR_PASSWORD ?? 'migrator_test_password',
  };
}

/** Спавнит pgshim psql один раз, скармливая весь SQL через stdin. */
function runPsql(sqlText: string, env: SuperuserPsqlEnv): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      env.psql,
      [
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        `APP_PASSWORD=${env.appPassword}`,
        '-v',
        `MIGRATOR_PASSWORD=${env.migratorPassword}`,
        '-q',
      ],
      {
        env: {
          ...process.env,
          PGHOST: env.host,
          PGPORT: env.port,
          PGUSER: env.user,
          PGDATABASE: env.database,
          // Суперпользователь через /tmp-trust — пароль не нужен и мешать не должен.
          PGPASSWORD: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stdout?.on('data', () => {
      /* вывод миграций не нужен */
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Накат миграций провалился (psql exit ${code}): ${stderr.trim()}`));
      }
    });
    // stdin может закрыться раньше при ранней ошибке psql — глушим EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(sqlText);
  });
}

/**
 * Накатывает ВСЕ миграции db/migrations/*.sql в порядке версий (из listMigrations()).
 * Весь SQL конкатенируется и исполняется одним спавном pgshim psql через stdin.
 *
 * Идемпотентен: повторный вызов на уже накатанной БД — no-op (для тестов
 * «двойной накат»).
 */
export async function applyAllMigrations(): Promise<void> {
  const env = resolveSuperuserPsqlEnv();
  const migrations = await listMigrations();

  const chunks: string[] = [];
  for (const migration of migrations) {
    const text = await readFile(migration.path, 'utf8');
    // Заголовок-комментарий на файл — для диагностики (pgshim корректно игнорирует
    // -- комментарии). Разделитель '\n\n' исключает «слипание» последней строки
    // одного файла (напр. однострочного комментария) с началом следующего.
    chunks.push(`-- ===== ${migration.version}_${migration.name} =====\n${text}`);
  }

  await runPsql(chunks.join('\n\n'), env);
}
