/**
 * Часовой пояс магазина для экранов оператора (аудит 2026-07-28, major №26).
 *
 * ПРОБЛЕМА. Время в админке рендерилось в трёх разных системах координат:
 * журнал аудита жёстко ставил 'Europe/Moscow', список заказов и карточка не
 * ставили ничего (⇒ пояс контейнера, обычно UTC), а фильтр «за период» резал по
 * UTC-суткам. Оператор видел ОДНО событие с разным временем на соседних экранах,
 * а «заказы за сегодня» теряли ночные заказы: в МСК (UTC+3) заказ, сделанный в
 * 01:00, лежит в предыдущих UTC-сутках.
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ. Москва здесь НЕ хардкодится — платформа рассчитана на
 * магазины в разных поясах. Приоритет источников:
 *   1) настройка магазина  shop_settings.branding.timeZone  (правится в админке);
 *   2) env инстанса        SHOP_TIMEZONE                    (дефолт этого VPS);
 *   3) дефолт платформы    DEFAULT_SHOP_TIME_ZONE           (базовый рынок).
 * Никакой миграции для этого не нужно: shop_settings — jsonb key/value (0019),
 * ключ `branding` уже существует, поле аддитивно и опционально.
 *
 * FAIL-SAFE. Ни одна функция не бросает: битый идентификатор пояса откатывается
 * на следующий источник, а в пределе — на дефолт платформы. Ячейка таблицы или
 * фильтр не имеют права уронить страницу из-за опечатки в настройке.
 */

import {
  DEFAULT_SHOP_TIME_ZONE,
  SHOP_TIME_ZONE_ENV,
  parseTimeZone,
} from './timezone-token';

/**
 * Чистая часть живёт в client-safe leaf './timezone-token' — её импортирует
 * lib/admin/order-format, который тянут КЛИЕНТСКИЕ компоненты. Этот модуль
 * добавляет к ней чтение настройки из БД и потому серверный. Ре-экспорт даёт
 * серверным потребителям один вход.
 */
export {
  DEFAULT_SHOP_TIME_ZONE,
  SHOP_TIME_ZONE_ENV,
  parseTimeZone,
} from './timezone-token';

/** Сырое значение ключа `branding` (нужно только поле timeZone). */
export interface BrandingTimeZoneSource {
  timeZone?: unknown;
}

/**
 * Резолвит эффективный пояс по приоритету «настройка → env → дефолт платформы».
 * Источник env инъектируется (чистая функция, тестируема без process.env).
 */
export function resolveShopTimeZone(
  branding: BrandingTimeZoneSource | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    parseTimeZone(branding?.timeZone) ??
    parseTimeZone(env[SHOP_TIME_ZONE_ENV]) ??
    DEFAULT_SHOP_TIME_ZONE
  );
}

/** Читатель сырого значения shop_settings.branding (инъекция для тестов/границы). */
export type BrandingReader = () => Promise<BrandingTimeZoneSource | null>;

/**
 * Эффективный пояс магазина для серверных страниц админки. Читает настройку
 * (по умолчанию — из репозитория настроек), при отсутствии/ошибке отдаёт дефолт.
 * Не бросает: недоступная БД не должна ронять журнал аудита.
 */
export async function getShopTimeZone(
  reader?: BrandingReader,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const read = reader ?? defaultBrandingReader;
  try {
    return resolveShopTimeZone(await read(), env);
  } catch {
    return resolveShopTimeZone(null, env);
  }
}

/** Продакшн-читатель: тянет shop_settings.branding через репозиторий настроек. */
async function defaultBrandingReader(): Promise<BrandingTimeZoneSource | null> {
  const { getSetting } = await import('@/lib/settings/repository');
  const row = await getSetting('branding');
  return (row?.value as BrandingTimeZoneSource | undefined) ?? null;
}

// -----------------------------------------------------------------------------
// Границы суток магазина в UTC (фильтр «за период» в списках).
// -----------------------------------------------------------------------------

/** 'YYYY-MM-DD' из <input type="date">. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Смещение пояса от UTC в минутах для конкретного мгновения (учитывает переход
 * на летнее время). Приём стандартный: форматируем мгновение в целевом поясе,
 * читаем обратно как UTC и берём разницу.
 */
function offsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // 'hour' в hour12:false может прийти как '24' для полуночи — нормализуем.
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * Момент UTC, соответствующий локальной полуночи заданной календарной даты в
 * поясе магазина. Двухпроходный расчёт: первое приближение по смещению в
 * «наивной» точке, затем уточнение по смещению в найденной точке — так корректно
 * ложатся сутки в дни перехода на летнее/зимнее время.
 */
function shopMidnightUtc(day: string, timeZone: string): Date {
  const naive = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
  const first = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60000);
  return new Date(naive - offsetMinutes(first, timeZone) * 60000);
}

/** Границы периода в UTC: [fromUtc, toUtc). Верхняя граница ЭКСКЛЮЗИВНА. */
export interface UtcDayRange {
  /** Начало суток `from` в поясе магазина, ISO-UTC; null — граница не задана. */
  fromUtc: string | null;
  /** Начало суток, СЛЕДУЮЩИХ за `to`, ISO-UTC; null — граница не задана. */
  toUtc: string | null;
}

/**
 * Переводит выбранные оператором календарные даты (в поясе МАГАЗИНА) в границы
 * UTC для запроса `created_at >= fromUtc AND created_at < toUtc`.
 *
 * 🔴 Верхняя граница ЭКСКЛЮЗИВНА (начало следующих суток), а не «конец дня минус
 * миллисекунда»: это единственный способ не потерять события последней доли
 * секунды и не зависеть от точности timestamptz.
 *
 * Мусорный ввод (не 'YYYY-MM-DD') трактуется как «граница не задана» — фильтр
 * просто не сужает выборку, вместо падения страницы. Битый пояс → дефолт платформы.
 */
export function utcDayRangeForShopDay(
  from: string | null | undefined,
  to: string | null | undefined,
  timeZone: string,
): UtcDayRange {
  const tz = parseTimeZone(timeZone) ?? DEFAULT_SHOP_TIME_ZONE;
  const valid = (d: string | null | undefined): string | null =>
    typeof d === 'string' && DATE_RE.test(d.trim()) ? d.trim() : null;

  const fromDay = valid(from);
  const toDay = valid(to);

  return {
    fromUtc: fromDay ? shopMidnightUtc(fromDay, tz).toISOString() : null,
    // Конец периода включает выбранный день целиком → берём полночь СЛЕДУЮЩЕГО дня.
    toUtc: toDay ? nextDayMidnightUtc(toDay, tz).toISOString() : null,
  };
}

/** Полночь дня, следующего за `day`, в поясе магазина → UTC. */
function nextDayMidnightUtc(day: string, timeZone: string): Date {
  const next = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1),
  );
  const iso = next.toISOString().slice(0, 10);
  return shopMidnightUtc(iso, timeZone);
}
