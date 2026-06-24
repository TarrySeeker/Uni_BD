/**
 * Лёгкая самохостовая аналитика для дашборда (Prevki.md «2 графика: заказы и
 * посещения»). Внешняя аналитика исключена (самохостинг, без внешних сервисов),
 * поэтому считаем сами:
 *   • посещения витрины — суточный счётчик storefront_pageviews (миграция 0028),
 *     инкрементируется beacon-роутом POST /api/storefront/v1/events/pageview;
 *   • заказы по дням — агрегат по orders.created_at.
 *
 * Ряды для графиков строит ЧИСТАЯ, тестируемая функция buildDailySeries (вход —
 * карта день→количество и «сегодня» по календарю БД), а DB-функции лишь читают.
 * getDashboardSeries устойчива: отсутствие таблицы (стенд без миграции 0028) или
 * модуля orders → пустой ряд (нули), дашборд не падает.
 */

import { sql } from '@/lib/db/client';

/** Точка ряда графика: сутки + подпись оси + значение. */
export interface DailyPoint {
  /** YYYY-MM-DD (календарь БД). */
  day: string;
  /** Короткая подпись под столбцом, ДД.ММ. */
  label: string;
  /** Значение за сутки (≥ 0). */
  count: number;
}

/** Короткая метка ДД.ММ из ISO-дня YYYY-MM-DD. */
function shortLabel(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/** ISO-день (YYYY-MM-DD) из UTC-миллисекунд. */
function isoDayFromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Непрерывный ряд из N последних суток (включая `today`), 0 — для дней без данных.
 * Чистая: вход — карта day→count и «сегодня» (YYYY-MM-DD по календарю БД); строки
 * ключей и ось считаются в одном календаре, поэтому без рассинхрона по таймзоне.
 */
export function buildDailySeries(
  countsByDay: Map<string, number>,
  days: number,
  today: string,
): DailyPoint[] {
  // Парсим «сегодня» как UTC-полночь — арифметика суток без сдвигов локали.
  const base = Date.parse(`${today}T00:00:00Z`);
  const out: DailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const iso = isoDayFromUtcMs(base - i * 86_400_000);
    out.push({ day: iso, label: shortLabel(iso), count: countsByDay.get(iso) ?? 0 });
  }
  return out;
}

/**
 * UPSERT-инкремент счётчика просмотров за сегодня (вызывается beacon-роутом).
 * Идемпотентность не требуется (каждое открытие страницы = +1).
 */
export async function recordPageview(): Promise<void> {
  await sql`
    INSERT INTO storefront_pageviews (day, views)
    VALUES (current_date, 1)
    ON CONFLICT (day) DO UPDATE SET views = storefront_pageviews.views + 1
  `;
}

/** «Сегодня» по календарю БД (та же база, что current_date / created_at::date). */
async function dbToday(): Promise<string> {
  const rows = await sql<{ today: string }[]>`SELECT to_char(current_date, 'YYYY-MM-DD') AS today`;
  return rows[0]!.today;
}

/**
 * Заказов по дням за последние `days` суток (включая сегодня). Карта day→count.
 *
 * ⚠️ `current_date - ${days}::int` — каст ОБЯЗАТЕЛЕН. Без него postgres.js шлёт
 * `${days}` bound-параметром, тип которого Postgres в выражении `current_date - $1`
 * выводит как `date` (есть оператор `date - date → integer`) → выражение даёт
 * integer → `created_at::date > integer` падает с `operator does not exist`. Ошибка
 * глоталась `catch` ниже → пустая Map → оба графика дашборда ВСЕГДА «нет данных»
 * даже при наличии заказов/посещений. Каст `::int` форсит `date - int → date`.
 */
async function ordersByDay(days: number): Promise<Map<string, number>> {
  try {
    const rows = await sql<{ day: string; n: number }[]>`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, count(*)::bigint AS n
        FROM orders
       WHERE created_at::date > current_date - ${days}::int
       GROUP BY 1
    `;
    return new Map(rows.map((r) => [r.day, Number(r.n)]));
  } catch {
    return new Map();
  }
}

/** Просмотров витрины по дням за последние `days` суток. Карта day→views. */
async function viewsByDay(days: number): Promise<Map<string, number>> {
  try {
    const rows = await sql<{ day: string; n: number }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, views::bigint AS n
        FROM storefront_pageviews
       WHERE day > current_date - ${days}::int
    `;
    return new Map(rows.map((r) => [r.day, Number(r.n)]));
  } catch {
    return new Map();
  }
}

/**
 * Ряды для двух графиков дашборда за последние `days` суток. Устойчива к
 * отсутствию таблиц/модулей (пустые ряды нулей вместо падения).
 */
export async function getDashboardSeries(
  days = 14,
): Promise<{ orders: DailyPoint[]; views: DailyPoint[] } | null> {
  let today: string;
  try {
    today = await dbToday();
  } catch {
    // Нет БД (dev без Postgres) → дашборд просто не покажет графики.
    return null;
  }
  const [orderCounts, viewCounts] = await Promise.all([ordersByDay(days), viewsByDay(days)]);
  return {
    orders: buildDailySeries(orderCounts, days, today),
    views: buildDailySeries(viewCounts, days, today),
  };
}
