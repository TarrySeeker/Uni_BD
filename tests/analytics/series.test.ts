import { describe, it, expect } from 'vitest';

import { buildDailySeries } from '@/lib/analytics/repository';

/**
 * Чистая логика рядов для графиков дашборда (Prevki.md). DB-функции
 * (recordPageview/getDashboardSeries) — интеграционные (нужен Postgres), здесь
 * проверяем только построение непрерывного ряда с нулями и подписями.
 */
describe('analytics/buildDailySeries', () => {
  it('возвращает ровно N точек, заканчивая «сегодня», по возрастанию дат', () => {
    const s = buildDailySeries(new Map(), 14, '2026-06-17');
    expect(s).toHaveLength(14);
    expect(s[0]!.day).toBe('2026-06-04'); // today - 13
    expect(s[13]!.day).toBe('2026-06-17'); // today
    // строго возрастает
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.day > s[i - 1]!.day).toBe(true);
    }
  });

  it('дни без данных → 0, дни с данными → их значение', () => {
    const counts = new Map([
      ['2026-06-17', 5],
      ['2026-06-15', 2],
    ]);
    const s = buildDailySeries(counts, 7, '2026-06-17');
    const byDay = Object.fromEntries(s.map((p) => [p.day, p.count]));
    expect(byDay['2026-06-17']).toBe(5);
    expect(byDay['2026-06-15']).toBe(2);
    expect(byDay['2026-06-16']).toBe(0);
    expect(byDay['2026-06-11']).toBe(0);
  });

  it('подпись label — в формате ДД.ММ', () => {
    const s = buildDailySeries(new Map(), 1, '2026-06-07');
    expect(s[0]!.label).toBe('07.06');
  });

  it('корректно переходит через границу месяца', () => {
    const s = buildDailySeries(new Map(), 3, '2026-07-01');
    expect(s.map((p) => p.day)).toEqual(['2026-06-29', '2026-06-30', '2026-07-01']);
  });

  it('игнорирует значения вне окна (не попадают в ряд)', () => {
    const counts = new Map([['2026-05-01', 99]]);
    const s = buildDailySeries(counts, 5, '2026-06-17');
    expect(s.some((p) => p.day === '2026-05-01')).toBe(false);
    expect(s.reduce((sum, p) => sum + p.count, 0)).toBe(0);
  });
});
