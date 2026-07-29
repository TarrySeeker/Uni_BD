/**
 * Часовой пояс магазина — ЧИСТЫЙ client-safe leaf (аудит major №26).
 *
 * WHY отдельный файл (тот же приём, что lib/i18n/locale-token.ts против
 * lib/i18n/config.ts): timezone.ts резолвит пояс из shop_settings и потому тянет
 * цепочку lib/settings/repository → lib/db/client → драйвер postgres. Этот модуль
 * импортирует lib/admin/order-format, а его, в свою очередь, импортируют
 * КЛИЕНТСКИЕ компоненты (OrderFilters, PromoForm). Если бы формат времени тянул
 * БД, прод-сборка упала бы на «Module not found: Can't resolve 'fs'/'net'/'tls'» —
 * ровно это и ловит tests/build/client-server-boundary.guard.test.ts.
 *
 * Поэтому здесь только то, что безопасно исполнить в браузере: константа дефолта
 * и валидация идентификатора через Intl. Ноль БД, ноль server-only.
 */

/**
 * Дефолт платформы. Базовый рынок Admik — РФ, поэтому московское время остаётся
 * наиболее ожидаемым «из коробки»; но это именно ДЕФОЛТ, а не хардкод: магазин
 * в любом поясе переопределяет его одной настройкой, и все экраны едут вместе.
 */
export const DEFAULT_SHOP_TIME_ZONE = 'Europe/Moscow';

/** Имя env-переменной с поясом инстанса (дефолт VPS конкретного магазина). */
export const SHOP_TIME_ZONE_ENV = 'SHOP_TIMEZONE';

/**
 * Валидирует IANA-идентификатор пояса средствами самой платформы (Intl бросает
 * RangeError на неизвестном поясе). Возвращает нормализованную строку или null.
 * Не бросает: вход может прийти из БД/env, отредактированных руками.
 */
export function parseTimeZone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tz = raw.trim();
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}
