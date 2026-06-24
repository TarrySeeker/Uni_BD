import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * РЕГРЕСС (BUG, correctness): счётчики аналитики — bigint-колонки
 * (storefront_pageviews.views, count(*) по orders), а запросы кастили их в
 * `::int` (int4, max 2_147_483_647). При значении > int4 Postgres бросает
 * overflow → весь SELECT падает → ряд графика тихо обнуляется (catch → пустая
 * карта). ОЖИДАНИЕ: касты — `::bigint` (или без каста), большое значение
 * (например 3_000_000_000) проходит через Number(r.n) без обрезки/NaN и
 * попадает в ряд buildDailySeries.
 *
 * DB-функции (ordersByDay/viewsByDay) приватные — проверяем через экспортную
 * getDashboardSeries, перехватывая текст SQL и подсовывая большие значения.
 */

// --- управляемое состояние мока sql ------------------------------------------

const H = vi.hoisted(() => {
  const state = {
    /** Все перехваченные сырые тексты SQL-запросов (template strings, склеенные). */
    queries: [] as string[],
    /** Карта: подстрока-маркер запроса → строки результата. */
    results: [] as { marker: string; rows: unknown[] }[],
  };

  const sqlTagged = vi.fn((strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    state.queries.push(text);
    const hit = state.results.find((r) => text.includes(r.marker));
    return Promise.resolve(hit ? hit.rows : []);
  });

  return { state, sqlTagged };
});

vi.mock('@/lib/db/client', () => {
  const sqlFn = (strings: TemplateStringsArray, ...vals: unknown[]) => H.sqlTagged(strings, ...vals);
  return { sql: sqlFn };
});

import { getDashboardSeries } from '@/lib/analytics/repository';

beforeEach(() => {
  H.state.queries = [];
  H.state.results = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('analytics/repository — bigint касты счётчиков', () => {
  it('views читается как ::bigint (не ::int) и БЕЗ ::int-каста', () => {
    H.state.results = [{ marker: 'current_date', rows: [{ today: '2026-06-17' }] }];

    return getDashboardSeries(14).then(() => {
      const viewsQ = H.state.queries.find((q) => q.includes('storefront_pageviews'));
      expect(viewsQ).toBeDefined();
      expect(viewsQ).toContain('views::bigint');
      // именно столбец views не должен кастоваться в int4
      expect(viewsQ).not.toContain('views::int');
    });
  });

  it('count(*) по orders читается как ::bigint (не ::int)', () => {
    H.state.results = [{ marker: 'current_date', rows: [{ today: '2026-06-17' }] }];

    return getDashboardSeries(14).then(() => {
      const ordersQ = H.state.queries.find(
        (q) => q.includes('FROM orders') && q.includes('count(*)'),
      );
      expect(ordersQ).toBeDefined();
      expect(ordersQ).toContain('count(*)::bigint');
      expect(ordersQ).not.toContain('count(*)::int');
    });
  });

  /**
   * РЕГРЕСС (BUG, correctness): параметр `days` в `current_date - ${days}` ОБЯЗАН
   * кастоваться `::int`. Без каста postgres.js шлёт его bound-параметром, и
   * Postgres выводит тип $1 как `date` (есть оператор `date - date → integer`) →
   * выражение даёт integer → `created_at::date > integer` падает (`operator does
   * not exist: date > integer`). Ошибка глоталась catch → пустая карта → ОБА
   * графика дашборда ВСЕГДА «нет данных» даже при наличии заказов/посещений.
   */
  it('параметр days кастится ::int в обоих запросах (иначе date - $1 = date-date = integer → запрос падает)', () => {
    H.state.results = [{ marker: 'current_date', rows: [{ today: '2026-06-17' }] }];

    return getDashboardSeries(14).then(() => {
      const ordersQ = H.state.queries.find(
        (q) => q.includes('FROM orders') && q.includes('count(*)'),
      );
      const viewsQ = H.state.queries.find((q) => q.includes('storefront_pageviews'));
      expect(ordersQ).toMatch(/current_date\s*-\s*\?::int/);
      expect(viewsQ).toMatch(/current_date\s*-\s*\?::int/);
    });
  });

  it('большое значение views (3_000_000_000 > int4 max) не обрезается и попадает в ряд', async () => {
    H.state.results = [
      { marker: 'today', rows: [{ today: '2026-06-17' }] },
      {
        marker: 'storefront_pageviews',
        rows: [{ day: '2026-06-17', n: '3000000000' }], // bigint приходит строкой из postgres.js
      },
      { marker: 'FROM orders', rows: [] },
    ];

    const series = await getDashboardSeries(14);
    expect(series).not.toBeNull();
    const todayPoint = series!.views.find((p) => p.day === '2026-06-17');
    expect(todayPoint).toBeDefined();
    expect(todayPoint!.count).toBe(3_000_000_000);
    expect(Number.isNaN(todayPoint!.count)).toBe(false);
    expect(todayPoint!.count).toBeGreaterThan(2_147_483_647);
  });
});
