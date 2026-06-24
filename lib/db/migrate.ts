import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Вспомогательный слой для работы с файлами миграций db/migrations/*.sql.
 *
 * Назначение: дать тестам идемпотентности и потенциальному node-раннеру единый,
 * детерминированный список миграций. Порядок наката — лексикографическая сортировка
 * имён (совместимо с scripts/init-shop.sh, который сортирует через `sort`).
 */

/** Каталог с миграциями (абсолютный путь). */
export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'db',
  'migrations',
);

/** Описание одной миграции. */
export interface MigrationFile {
  /** Версия — 4-значный префикс имени файла, например '0001'. */
  version: string;
  /** Имя миграции без префикса версии и расширения, например 'init_extensions_and_migrations'. */
  name: string;
  /** Абсолютный путь к .sql-файлу. */
  path: string;
}

/** Результат разбора имени файла миграции (без пути). */
export type ParsedMigrationName = Pick<MigrationFile, 'version' | 'name'>;

/**
 * Имя файла миграции: NNNN_имя.sql, где NNNN — ровно 4 цифры.
 * Группы: (1) версия, (2) имя без расширения.
 */
const MIGRATION_NAME_RE = /^(\d{4})_(.+)\.sql$/;

/**
 * Чистая функция: разбирает имя файла миграции `NNNN_name.sql`
 * в `{ version: 'NNNN', name: 'name' }`.
 *
 * Бросает ошибку, если имя не соответствует формату (защита от случайных файлов
 * в каталоге миграций). Покрыта юнит-тестами (без БД).
 */
export function parseMigrationName(fileName: string): ParsedMigrationName {
  const match = MIGRATION_NAME_RE.exec(fileName);
  if (!match) {
    throw new Error(
      `Некорректное имя файла миграции: "${fileName}". ` +
        'Ожидается формат NNNN_имя.sql (4 цифры, подчёркивание, имя, .sql).',
    );
  }
  return { version: match[1], name: match[2] };
}

/**
 * Чистая функция: из произвольного списка имён файлов оставляет только валидные
 * миграции и возвращает их разобранными и отсортированными лексикографически по
 * имени файла (= по версии, т.к. версия — это 4-значный префикс с ведущими нулями).
 *
 * Не-.sql и не подходящие под формат файлы игнорируются (например, .gitkeep).
 */
export function sortMigrationNames(fileNames: readonly string[]): ParsedMigrationName[] {
  return fileNames
    .filter((name) => MIGRATION_NAME_RE.test(name))
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(parseMigrationName);
}

/**
 * Читает каталог db/migrations, отбирает валидные .sql-миграции и возвращает их
 * в порядке наката (лексикографически по имени файла) с абсолютными путями.
 *
 * @param dir переопределение каталога (по умолчанию MIGRATIONS_DIR) — удобно в тестах.
 */
export async function listMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const valid = entries.filter((name) => MIGRATION_NAME_RE.test(name));
  valid.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return valid.map((fileName) => {
    const { version, name } = parseMigrationName(fileName);
    return { version, name, path: join(dir, fileName) };
  });
}
