// =============================================================================
// scripts/load-product-colors.mjs
// -----------------------------------------------------------------------------
// ETL-загрузчик дисплейных цвето-свотчей товара (products.colors, миграция 0050)
// — легаси-блок carre `.wv__colors`. Заполняет колонку colors для СУЩЕСТВУЮЩИХ
// товаров, сматчивая источник по slug (b_work.link = products.slug).
//
// Это НЕ покупаемые варианты/SKU — product_variants скрипт НЕ трогает.
//
// ИСТОЧНИК (генерируется координатором read-only с прода carrerusse.com и
// передаётся ФАЙЛОМ) — JSON вида:
//   {
//     "<slug>": [ { "hex": "#rrggbb", "name": "<ru-имя>" }, ... ],
//     ...
//   }
// где:
//   • ключ  = products.slug (== b_work.link на старом сайте);
//   • массив = цвета в порядке показа (первый = основной color_hex/master_color,
//              второй = color_hex_2/master_color_2); может быть пустым;
//   • hex    = '#rrggbb' (строка; регистр не важен) — красит кружок;
//   • name   = русское имя из словаря b_master_colors ('' допустимо — title пуст).
// Записи без валидного hex отбрасываются (нечего красить).
//
// ИДЕМПОТЕНТНОСТЬ: для каждого slug пишем colors через UPDATE (полная замена
// массива). Повторный запуск с тем же JSON = тот же результат. Товары, которых
// нет в JSON, не трогаются. Неизвестные slug (нет такого товара) — пропускаются
// с предупреждением, НЕ ошибка (каталоги могут расходиться).
//
// ПОДКЛЮЧЕНИЕ К БД (тот же приоритет, что db/seed/owner.mjs):
//   1) SEED_DATABASE_URL  — явный override;
//   2) PG* (PGUSER/PGPASSWORD/PGHOST/PGPORT/PGDATABASE) — как их экспортирует
//      init-shop.sh / карре-devdb (владелец БД);
//   3) DATABASE_URL       — fallback (рантайм-роль admik_app имеет UPDATE на products).
//
// ЗАПУСК:
//   node scripts/load-product-colors.mjs <path-to-colors.json>
//   node scripts/load-product-colors.mjs <path-to-colors.json> --dry-run
//     (--dry-run: только сверка/статистика без записи в БД)
//
// КОД ВОЗВРАТА: 0 — успех (даже если часть slug неизвестна); ≠0 — фатальная
//   ошибка (нет файла / битый JSON / нет подключения / ошибка SQL).
// =============================================================================

import { readFileSync } from 'node:fs';
import postgres from 'postgres';

/** Логирование с префиксом — единый стиль ETL-вывода. */
function info(msg) {
  console.log(`  [etl:colors] ${msg}`);
}
function warn(msg) {
  console.warn(`  [etl:colors] ⚠ ${msg}`);
}

/**
 * Строит подключение к БД (см. шапку, порядок приоритета).
 * Возвращает { kind:'url'|'options', value } либо null.
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
 * Нормализует произвольный массив цветов из источника → [{hex,name}].
 * Отбрасывает записи без строкового hex; name→'' если не строка. Чистая функция
 * (экспортируется для юнит-теста).
 */
export function normalizeColors(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof item.hex === 'string' && item.hex.length > 0) {
      out.push({
        hex: item.hex,
        name: typeof item.name === 'string' ? item.name : '',
      });
    }
  }
  return out;
}

/**
 * Разбирает и валидирует объект источника {slug: [...]}.
 * Возвращает Map<slug, ProductColor[]> (только валидные, нормализованные записи).
 * Чистая функция (экспортируется для юнит-теста).
 */
export function parseSource(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Источник должен быть JSON-объектом вида {slug: [{hex,name}]}.');
  }
  const map = new Map();
  for (const [slug, rawColors] of Object.entries(obj)) {
    if (typeof slug !== 'string' || slug.length === 0) continue;
    map.set(slug, normalizeColors(rawColors));
  }
  return map;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath) {
    console.error('Использование: node scripts/load-product-colors.mjs <colors.json> [--dry-run]');
    process.exit(1);
  }

  // --- Чтение и разбор источника ------------------------------------------
  let source;
  try {
    source = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`  [etl:colors] Не удалось прочитать/разобрать ${filePath}: ${err.message}`);
    process.exit(1);
  }

  let bySlug;
  try {
    bySlug = parseSource(source);
  } catch (err) {
    console.error(`  [etl:colors] ${err.message}`);
    process.exit(1);
  }

  info(`Источник: ${bySlug.size} товаров (slug) из ${filePath}.`);
  if (dryRun) info('Режим --dry-run: запись в БД НЕ производится.');

  const conn = resolveConnection();
  if (!conn) {
    console.error('  [etl:colors] Не заданы параметры подключения (SEED_DATABASE_URL / PG* / DATABASE_URL).');
    process.exit(1);
  }

  const sql =
    conn.kind === 'url'
      ? postgres(conn.value, { connection: { application_name: 'admik_etl_colors' } })
      : postgres({ ...conn.value, connection: { application_name: 'admik_etl_colors' } });

  let updated = 0;
  let unknown = 0;
  let cleared = 0;

  try {
    for (const [slug, colors] of bySlug) {
      const value = JSON.stringify(colors);
      if (dryRun) {
        // Только проверяем существование товара.
        const rows = await sql`SELECT 1 FROM products WHERE slug = ${slug} LIMIT 1`;
        if (rows.length === 0) {
          unknown += 1;
          warn(`slug не найден в каталоге: ${slug}`);
        } else {
          updated += 1;
          if (colors.length === 0) cleared += 1;
        }
        continue;
      }
      const rows = await sql`
        UPDATE products SET colors = ${value}::jsonb, updated_at = now()
        WHERE slug = ${slug}
        RETURNING id
      `;
      if (rows.length === 0) {
        unknown += 1;
        warn(`slug не найден в каталоге: ${slug}`);
      } else {
        updated += 1;
        if (colors.length === 0) cleared += 1;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  info(`Готово. Обновлено товаров: ${updated}${cleared ? ` (из них очищено до []: ${cleared})` : ''}.`);
  if (unknown > 0) warn(`Пропущено неизвестных slug: ${unknown} (не ошибка — каталоги могли разойтись).`);
  process.exit(0);
}

// Запуск только при прямом вызове (не при импорте чистых функций тестом).
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('  [etl:colors] Фатальная ошибка:', err);
    process.exit(1);
  });
}
