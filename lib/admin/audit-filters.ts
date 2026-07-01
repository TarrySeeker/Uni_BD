/**
 * Фильтры журнала аудита (тупик C1, docs/20).
 *
 * Страница аудита раньше читала только ?page — фильтрации по дате/действию/
 * инициатору/сущности не было (SELECT без WHERE), хотя индексы под это уже есть
 * (db/migrations/0004_audit.sql) и фильтрация — принятая конвенция (OrderFilters).
 *
 * Здесь — ЧИСТЫЕ хелперы (без БД/Next), по образцу parseFilter заказов:
 *   * parseAuditFilters — нормализация query-параметров (валидация словарями);
 *   * auditFilterBounds — расчёт значений для ПАРАМЕТРИЗОВАННОГО SQL (postgres.js
 *     биндит их, никакого string-concat в запросе).
 *
 * Мультитенантно: допустимые коды берутся из общих словарей AUDIT_*_LABELS, сами
 * записи аудита — per-instance; хардкода под конкретный магазин нет.
 */

import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_TYPE_LABELS } from './audit-labels';

/** Нормализованный фильтр журнала аудита. */
export interface AuditFilter {
  dateFrom?: string;
  dateTo?: string;
  action?: string;
  entityType?: string;
  actor?: string;
  page: number;
}

/** Значения для параметризованного SQL (все границы могут быть null = условие off). */
export interface AuditSqlBounds {
  action: string | null;
  entityType: string | null;
  actorLike: string | null;
  /** Нижняя граница периода, включительно (начало суток, UTC). */
  dateFrom: string | null;
  /** Верхняя граница периода, ИСКЛЮЧИТЕЛЬНО (начало следующих суток, UTC). */
  dateTo: string | null;
}

/** Валидна ли дата из <input type="date"> (или ISO). Пустая/мусор → false. */
function isValidDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Нормализует query-параметры в AuditFilter:
 *   * action — только ключ из AUDIT_ACTION_LABELS, иначе drop;
 *   * entityType — только ключ из AUDIT_ENTITY_TYPE_LABELS, иначе drop;
 *   * dateFrom/dateTo — валидная дата, иначе undefined;
 *   * actor — trim, пустой → undefined (ILIKE по actor_email на стороне SQL);
 *   * page — целое >= 1.
 */
export function parseAuditFilters(
  sp: Record<string, string | string[] | undefined>,
): AuditFilter {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const action = one('action');
  const entityType = one('entityType');
  const dateFrom = one('dateFrom');
  const dateTo = one('dateTo');
  const actor = one('actor')?.trim();
  const page = Number(one('page') ?? '1');

  return {
    dateFrom: dateFrom && isValidDate(dateFrom) ? dateFrom : undefined,
    dateTo: dateTo && isValidDate(dateTo) ? dateTo : undefined,
    action:
      action && Object.prototype.hasOwnProperty.call(AUDIT_ACTION_LABELS, action)
        ? action
        : undefined,
    entityType:
      entityType && Object.prototype.hasOwnProperty.call(AUDIT_ENTITY_TYPE_LABELS, entityType)
        ? entityType
        : undefined,
    actor: actor || undefined,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

/** Прибавляет один день к дате 'YYYY-MM-DD' (UTC), возвращает 'YYYY-MM-DD'. */
function nextDayIso(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Переводит фильтр в значения для параметризованного SQL. Период: created_at >=
 * dateFrom (начало суток) AND created_at < dateTo+1день (верх исключительно), чтобы
 * выбранный конечный день входил целиком. null означает «условие не применяется».
 */
export function auditFilterBounds(filter: AuditFilter): AuditSqlBounds {
  return {
    action: filter.action ?? null,
    entityType: filter.entityType ?? null,
    actorLike: filter.actor ? `%${filter.actor}%` : null,
    dateFrom: filter.dateFrom ? `${filter.dateFrom}T00:00:00.000Z` : null,
    dateTo: filter.dateTo ? `${nextDayIso(filter.dateTo)}T00:00:00.000Z` : null,
  };
}
