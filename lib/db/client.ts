import postgres from 'postgres';
import { getEnv } from '@/lib/config/env';

/**
 * Единый клиент доступа к БД (postgres.js) под ролью приложения (admik_app).
 *
 * ADR-001/ADR-002:
 *   * postgres.js с tagged templates — параметризация запросов и защита от SQL-инъекций.
 *     Используйте ТОЛЬКО tagged-форму `sql\`SELECT ... ${value}\``; никогда не
 *     склеивайте пользовательский ввод в строку запроса.
 *   * Подключение идёт под ролью app (минимальные права); миграции — отдельно под
 *     migrator/владельцем БД (init-shop.sh), не через этот клиент.
 *
 * Ленивая инициализация: реальное соединение создаётся при первом обращении к `sql`,
 * а не на этапе импорта модуля. Это позволяет импортировать модуль в окружениях без
 * заданного DATABASE_URL (тесты, сборка), не падая раньше времени.
 */

let client: postgres.Sql | undefined;

/**
 * Возвращает (создавая при необходимости) клиент postgres.js под ролью app.
 * Бросает понятную ошибку, если DATABASE_URL не задан в окружении.
 */
export function getSql(): postgres.Sql {
  if (client) {
    return client;
  }

  const { DATABASE_URL } = getEnv();

  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL не задан. Укажите строку подключения к БД (под ролью admik_app) ' +
        'в .env — без неё слой доступа к данным не может работать. См. .env.example.',
    );
  }

  client = postgres(DATABASE_URL, {
    // Явно: имена соединений помогают в диагностике пула на стороне БД.
    connection: { application_name: 'admik_app' },
  });

  return client;
}

/**
 * Tagged-template для параметризованных запросов.
 *
 * Это Proxy поверх ленивого клиента: позволяет писать `sql\`...\`` и обращаться к
 * методам (`sql.begin`, `sql.unsafe` и т.д.) как к обычному клиенту postgres.js,
 * при этом реальное соединение поднимается только при первом использовании.
 */
export const sql: postgres.Sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  apply(_target, _thisArg, argArray) {
    // Вызов tagged-template: sql`...`
    return (getSql() as unknown as (...a: unknown[]) => unknown)(...argArray);
  },
  get(_target, prop, receiver) {
    return Reflect.get(getSql() as object, prop, receiver);
  },
});

/**
 * Закрывает соединение с БД (graceful shutdown / очистка в тестах).
 * Безопасно вызывать, даже если клиент ещё не инициализирован.
 */
export async function closeSql(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
  }
}
