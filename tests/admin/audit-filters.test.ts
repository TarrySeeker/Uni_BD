import { describe, it, expect } from 'vitest';

import {
  parseAuditFilters,
  auditFilterBounds,
} from '@/lib/admin/audit-filters';

/**
 * Тупик C1 (docs/20): в журнале аудита нет фильтров (по дате/действию/инициатору/
 * сущности) — SELECT без WHERE. parseAuditFilters — чистая нормализация
 * query-параметров (по образцу parseFilter заказов), auditFilterBounds — чистый
 * расчёт значений для параметризованного SQL (анти-SQLi, биндит postgres.js).
 *
 * Мультитенантно: словари действий/сущностей и сами записи — per-instance, без
 * хардкода под один магазин.
 */

type Sp = Record<string, string | string[] | undefined>;

describe('parseAuditFilters — нормализация фильтров аудита', () => {
  it('(a) неизвестный action (не из AUDIT_ACTION_LABELS) → undefined', () => {
    expect(parseAuditFilters({ action: 'some.future.action' }).action).toBeUndefined();
    // известный код проходит
    expect(parseAuditFilters({ action: 'auth.login' }).action).toBe('auth.login');
  });

  it('(b) невалидный entityType → undefined; валидный проходит', () => {
    expect(parseAuditFilters({ entityType: 'unicorn' }).entityType).toBeUndefined();
    expect(parseAuditFilters({ entityType: 'user' }).entityType).toBe('user');
  });

  it('(c) невалидная дата → undefined; валидная → проходит', () => {
    const bad = parseAuditFilters({ dateFrom: 'not-a-date', dateTo: '' });
    expect(bad.dateFrom).toBeUndefined();
    expect(bad.dateTo).toBeUndefined();

    const good = parseAuditFilters({ dateFrom: '2026-06-20', dateTo: '2026-06-25' });
    expect(good.dateFrom).toBe('2026-06-20');
    expect(good.dateTo).toBe('2026-06-25');
  });

  it('(d) actor с пробелами → trim; пустой после trim → undefined', () => {
    expect(parseAuditFilters({ actor: '  admin@shop.ru  ' }).actor).toBe('admin@shop.ru');
    expect(parseAuditFilters({ actor: '   ' }).actor).toBeUndefined();
  });

  it('(e) page < 1 / NaN → 1; валидный → целое', () => {
    expect(parseAuditFilters({ page: '0' }).page).toBe(1);
    expect(parseAuditFilters({ page: '-5' }).page).toBe(1);
    expect(parseAuditFilters({ page: 'abc' }).page).toBe(1);
    expect(parseAuditFilters({ page: '3' }).page).toBe(3);
    expect(parseAuditFilters({ page: '2.9' }).page).toBe(2);
  });

  it('берёт первый элемент при массиве значений (как в заказах)', () => {
    const sp: Sp = { action: ['auth.login', 'auth.logout'] };
    expect(parseAuditFilters(sp).action).toBe('auth.login');
  });

  it('пустой searchParams → только page=1, остальное undefined', () => {
    const f = parseAuditFilters({});
    expect(f).toEqual({
      dateFrom: undefined,
      dateTo: undefined,
      action: undefined,
      entityType: undefined,
      actor: undefined,
      page: 1,
    });
  });
});

describe('auditFilterBounds — значения для параметризованного SQL', () => {
  it('пустой фильтр → все границы null (эквивалент отсутствию WHERE)', () => {
    const b = auditFilterBounds(parseAuditFilters({}));
    expect(b).toEqual({
      action: null,
      entityType: null,
      actorLike: null,
      dateFrom: null,
      dateTo: null,
    });
  });

  it('action+actor+dateFrom → ровно соответствующие фрагменты', () => {
    const b = auditFilterBounds(
      parseAuditFilters({ action: 'auth.login', actor: 'admin@shop.ru', dateFrom: '2026-06-20' }),
    );
    expect(b.action).toBe('auth.login');
    expect(b.actorLike).toBe('%admin@shop.ru%');
    expect(b.dateFrom).toBe('2026-06-20T00:00:00.000Z');
    expect(b.dateTo).toBeNull();
    expect(b.entityType).toBeNull();
  });

  it('dateTo → верхняя граница ИСКЛЮЧИТЕЛЬНО (следующий день, начало суток)', () => {
    const b = auditFilterBounds(parseAuditFilters({ dateTo: '2026-06-25' }));
    expect(b.dateTo).toBe('2026-06-26T00:00:00.000Z');
  });
});
