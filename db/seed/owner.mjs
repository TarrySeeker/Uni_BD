// =============================================================================
// db/seed/owner.mjs
// -----------------------------------------------------------------------------
// Этап 1, задача 1.7 — seed владельца магазина (docs/04 §4.2, §4.3, §5.4).
//
// Создаёт учётную запись владельца (is_owner = true, status = 'active') из
// переменных окружения OWNER_EMAIL / OWNER_PASSWORD и привязывает её к системной
// роли 'owner'. Пароль хешируется argon2id (@node-rs/argon2, параметры — те же,
// что в lib/auth/password.ts; продублированы здесь, т.к. это ESM-скрипт, а lib —
// TypeScript и не импортируется напрямую из .mjs без сборки).
//
// ИДЕМПОТЕНТНОСТЬ (§4.2): если пользователь с OWNER_EMAIL уже существует —
// скрипт НИЧЕГО не делает (ни создания, ни смены пароля). Повторный запуск
// безопасен.
//
// БЕЗОПАСНОСТЬ ПАРОЛЯ (§4.2):
//   * если OWNER_PASSWORD задан — используем его;
//   * если не задан — генерируем криптослучайный надёжный пароль (node:crypto)
//     и печатаем его ОДИН РАЗ в консоль с требованием сменить при первом входе.
//   В репозиторий/логи пароль не попадает (кроме этой одноразовой печати).
//
// ПОДКЛЮЧЕНИЕ К БД: seed выполняется на шаге init-shop под владельцем БД
//   (POSTGRES_USER), поэтому строка подключения берётся в порядке приоритета:
//     1) SEED_DATABASE_URL  — явный override для seed;
//     2) PG* (PGUSER/PGPASSWORD/PGHOST/PGPORT/PGDATABASE) — их экспортирует
//        init-shop.sh (владелец БД, есть права INSERT в любые таблицы);
//     3) DATABASE_URL       — fallback (рантайм-роль admik_app тоже имеет DML).
//
// Запуск: node db/seed/owner.mjs
// =============================================================================

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { hash } from '@node-rs/argon2';

// Прод-параметры argon2id — синхронны с lib/auth/password.ts (ARGON2_OPTIONS).
// Algorithm.Argon2id === 2, Version.V0x13 === 1 (фиксируем числами, см. lib).
const ARGON2_OPTIONS = {
  algorithm: 2,
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Логирование с префиксом — единый стиль вывода seed. */
function info(msg) {
  console.log(`  [seed:owner] ${msg}`);
}

/**
 * Строит строку подключения к БД (см. шапку файла, порядок приоритета).
 * Возвращает либо URL-строку, либо объект опций для postgres().
 */
function resolveConnection() {
  if (process.env.SEED_DATABASE_URL) {
    return { kind: 'url', value: process.env.SEED_DATABASE_URL };
  }
  if (process.env.PGUSER || process.env.PGHOST) {
    return {
      kind: 'options',
      value: {
        host: process.env.PGHOST ?? 'localhost',
        port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
      },
    };
  }
  if (process.env.DATABASE_URL) {
    return { kind: 'url', value: process.env.DATABASE_URL };
  }
  return null;
}

/**
 * Генерирует криптослучайный надёжный пароль (URL-safe base64, ~24 символа).
 */
function generatePassword() {
  return randomBytes(18).toString('base64url');
}

async function main() {
  const email = process.env.OWNER_EMAIL;
  if (!email) {
    info('OWNER_EMAIL не задан — пропускаю seed владельца.');
    info('Задайте OWNER_EMAIL в .env, чтобы создать учётку владельца.');
    return;
  }

  const conn = resolveConnection();
  if (!conn) {
    info(
      'Не заданы параметры подключения к БД (SEED_DATABASE_URL / PG* / DATABASE_URL).',
    );
    info('Пропускаю seed владельца.');
    return;
  }

  const sql =
    conn.kind === 'url'
      ? postgres(conn.value, { connection: { application_name: 'admik_seed' } })
      : postgres({ ...conn.value, connection: { application_name: 'admik_seed' } });

  try {
    // --- Идемпотентность: владелец с таким email уже есть? -------------------
    const existing = await sql`
      SELECT id FROM users WHERE email = ${email} LIMIT 1
    `;
    if (existing.length > 0) {
      info(`Владелец ${email} уже существует — ничего не делаю (идемпотентно).`);
      return;
    }

    // --- Пароль: из .env или автогенерация с одноразовой печатью -------------
    let password = process.env.OWNER_PASSWORD;
    let generated = false;
    if (!password || password.length === 0) {
      password = generatePassword();
      generated = true;
    }

    const passwordHash = await hash(password, ARGON2_OPTIONS);

    // --- Создание владельца + привязка к роли owner в одной транзакции -------
    await sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO users (email, password_hash, display_name, status, is_owner)
        VALUES (${email}, ${passwordHash}, ${'Владелец'}, ${'active'}, ${true})
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `;

      // Если ON CONFLICT всё же сработал (гонка) — выходим без привязки.
      if (inserted.length === 0) {
        info(`Владелец ${email} уже существует (гонка) — пропускаю.`);
        return;
      }

      const userId = inserted[0].id;

      await tx`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${userId}, r.id FROM roles r WHERE r.code = ${'owner'}
        ON CONFLICT (user_id, role_id) DO NOTHING
      `;

      info(`Владелец ${email} создан (is_owner = true, status = active).`);
    });

    // --- Одноразовая печать сгенерированного пароля -------------------------
    if (generated) {
      console.log('');
      console.log('  ============================================================');
      console.log('  ВНИМАНИЕ: пароль владельца сгенерирован автоматически.');
      console.log(`    Email:  ${email}`);
      console.log(`    Пароль: ${password}`);
      console.log('  Этот пароль показан ОДИН РАЗ. Сохраните его и СМЕНИТЕ');
      console.log('  при первом входе в админку.');
      console.log('  ============================================================');
      console.log('');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('  [seed:owner] Ошибка при создании владельца:', err);
  process.exit(1);
});
