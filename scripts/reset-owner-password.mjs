// =============================================================================
// scripts/reset-owner-password.mjs
// -----------------------------------------------------------------------------
// Аварийный сброс пароля администратора магазина.
//
// ЗАЧЕМ ЭТО В ПЛАТФОРМЕ. На боевом магазине сложилась тупиковая ситуация:
// владелец забыл пароль от админки, ссылки «забыли пароль» на странице входа
// нет, SMTP не настроен (письмо со сбросом отправить некуда) — и попасть в
// собственную админку стало невозможно в принципе. Единственным выходом
// оказался ручной UPDATE хеша в БД, который пришлось писать прямо на сервере,
// под диктовку, без права на ошибку. Этот скрипт делает ту же операцию
// предсказуемо, идемпотентно и с проверками.
//
// ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ. Это не «восстановление пароля» для покупателя и не
// замена почтовому сбросу. Это инструмент оператора сервера: запускается ТОЛЬКО
// на машине, где уже есть доступ к БД. Тот, кто может его выполнить, и так
// имеет полный доступ к данным — новых прав скрипт не даёт.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ db/seed/owner.mjs: seed идемпотентно СОЗДАЁТ владельца и
// намеренно НЕ трогает пароль существующего. Здесь наоборот — пользователь
// обязан существовать, а его пароль заменяется.
//
// БЕЗОПАСНОСТЬ:
//   * пароль можно не задавать — тогда генерируется криптослучайный и печатается
//     ОДИН РАЗ (в репозиторий/логи приложения не попадает);
//   * заданный пароль читается из окружения, а НЕ из аргументов командной
//     строки — аргументы видны в `ps` любому пользователю системы;
//   * учётка попутно активируется (status='active'): заблокированный владелец
//     со свежим паролем всё равно не вошёл бы;
//   * все сессии пользователя закрываются — если пароль утёк, старая сессия
//     злоумышленника не должна пережить сброс.
//
// ЗАПУСК (из корня проекта, на сервере магазина):
//   node scripts/reset-owner-password.mjs                    # владелец из OWNER_EMAIL
//   RESET_EMAIL=user@shop.ru node scripts/reset-owner-password.mjs
//   RESET_PASSWORD='...' node scripts/reset-owner-password.mjs
//
// Строка подключения — как в db/seed/owner.mjs:
//   1) SEED_DATABASE_URL → 2) PG* → 3) DATABASE_URL.
// =============================================================================

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { hash } from '@node-rs/argon2';

// Прод-параметры argon2id — синхронны с lib/auth/password.ts (ARGON2_OPTIONS)
// и db/seed/owner.mjs. РАСХОЖДЕНИЕ НЕДОПУСТИМО: хеш, посчитанный другими
// параметрами, приложение проверить не сможет — вход будет отклонён, а причина
// внешне неотличима от «неверный пароль».
const ARGON2_OPTIONS = {
  algorithm: 2,
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Логирование с префиксом — единый стиль вывода скриптов. */
function info(msg) {
  console.log(`  [reset-password] ${msg}`);
}

/** Строит подключение к БД (порядок приоритета — см. шапку файла). */
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

/** Криптослучайный надёжный пароль (URL-safe base64, ~24 символа). */
function generatePassword() {
  return randomBytes(18).toString('base64url');
}

async function main() {
  // Кого сбрасываем: явный RESET_EMAIL, иначе владелец инстанса из .env.
  const email = process.env.RESET_EMAIL ?? process.env.OWNER_EMAIL;
  if (!email) {
    info('Не задано, кому сбрасывать пароль.');
    info('Укажите RESET_EMAIL=<email> (или задайте OWNER_EMAIL в .env).');
    process.exitCode = 1;
    return;
  }

  const conn = resolveConnection();
  if (!conn) {
    info('Не заданы параметры подключения к БД (SEED_DATABASE_URL / PG* / DATABASE_URL).');
    process.exitCode = 1;
    return;
  }

  // Пароль из окружения (не из argv — аргументы видны в `ps`), иначе генерируем.
  let password = process.env.RESET_PASSWORD;
  let generated = false;
  if (!password || password.length === 0) {
    password = generatePassword();
    generated = true;
  } else if (password.length < 8) {
    // Тот же минимум, что и в admin-schemas.ts: скрипт не должен быть лазейкой
    // для пароля слабее, чем разрешает форма админки.
    info('RESET_PASSWORD короче 8 символов — отказываюсь ставить слабый пароль.');
    process.exitCode = 1;
    return;
  }

  const sql =
    conn.kind === 'url'
      ? postgres(conn.value, { connection: { application_name: 'admik_reset_password' } })
      : postgres({ ...conn.value, connection: { application_name: 'admik_reset_password' } });

  try {
    const found = await sql`
      SELECT id, is_owner, status FROM users WHERE email = ${email} LIMIT 1
    `;
    if (found.length === 0) {
      // Осознанно НЕ создаём пользователя: создание — работа db/seed/owner.mjs.
      // Молчаливое создание учётки по опечатке в email — худший исход.
      info(`Пользователь ${email} не найден — ничего не менял.`);
      info('Создание владельца — это db/seed/owner.mjs (запускается из scripts/init-shop.sh).');
      process.exitCode = 1;
      return;
    }

    const user = found[0];
    const passwordHash = await hash(password, ARGON2_OPTIONS);

    await sql.begin(async (tx) => {
      // Активируем учётку заодно: сброс пароля заблокированному пользователю
      // выглядел бы успешным, а войти он всё равно не смог бы.
      await tx`
        UPDATE users
           SET password_hash = ${passwordHash},
               status = ${'active'},
               updated_at = now()
         WHERE id = ${user.id}
      `;

      // Гасим активные сессии: сброс пароля обязан выкидывать всех, кто уже
      // вошёл со старым паролем (иначе утёкшая сессия переживает сброс).
      // Таблицы может не быть в старых схемах — это не повод валить сброс.
      try {
        await tx`DELETE FROM sessions WHERE user_id = ${user.id}`;
      } catch {
        info('Таблица sessions недоступна — активные сессии не сброшены (не критично).');
      }
    });

    info(`Пароль пользователя ${email} обновлён (status = active, сессии закрыты).`);
    if (!user.is_owner) {
      info('ВНИМАНИЕ: это НЕ владелец магазина (is_owner = false) — обычный сотрудник.');
    }

    if (generated) {
      console.log('');
      console.log('  ============================================================');
      console.log('  Пароль сгенерирован автоматически.');
      console.log(`    Email:  ${email}`);
      console.log(`    Пароль: ${password}`);
      console.log('  Показан ОДИН РАЗ. Передайте владельцу и попросите сменить');
      console.log('  при первом входе (Профиль → Смена пароля).');
      console.log('  ============================================================');
      console.log('');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('  [reset-password] Ошибка при сбросе пароля:', err);
  process.exit(1);
});
