/**
 * Дифф снимков аудита (тупик C0, docs/20).
 *
 * writeAudit (lib/audit/log.ts) пишет before_data/after_data как jsonb-снимки
 * изменённых полей, но журнал аудита их не показывал. diffAuditData — чистый
 * хелпер (без БД/Next), сравнивающий два произвольных JSON-объекта по объединению
 * ключей. Универсален над любой схемой данных → мультитенантно, без хардкода под
 * конкретный магазин (образец чистых мапперов lib/admin/audit-labels.ts).
 *
 * Санитизация чувствительных полей уже выполнена на записи (lib/audit/sanitize.ts),
 * поэтому здесь дополнительная очистка не нужна.
 */

/** Одна строка диффа: ключ и его переход from→to с типом изменения. */
export interface AuditDiffEntry {
  key: string;
  from: unknown;
  to: unknown;
  kind: 'added' | 'removed' | 'changed';
}

/**
 * Стабильная сериализация для сравнения значений по значению (deep-equal по JSON):
 * ключи объектов сортируются рекурсивно, чтобы разный порядок ключей не считался
 * различием. Массивы сохраняют порядок (он значим).
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/** Равны ли значения по значению (deep-equal по JSON). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Сравнивает снимки до/после по объединению ключей.
 *   * before=null   → все ключи after помечаются 'added' (from=undefined).
 *   * after=null    → все ключи before помечаются 'removed' (to=undefined).
 *   * ключ в обоих, значения равны (deep-equal) → отбрасывается.
 *   * ключ в обоих, значения различны → 'changed'.
 * Порядок результата детерминирован (ключи по алфавиту).
 */
export function diffAuditData(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditDiffEntry[] {
  const keys = new Set<string>([
    ...(before ? Object.keys(before) : []),
    ...(after ? Object.keys(after) : []),
  ]);

  const result: AuditDiffEntry[] = [];
  for (const key of [...keys].sort()) {
    const inBefore = before != null && Object.prototype.hasOwnProperty.call(before, key);
    const inAfter = after != null && Object.prototype.hasOwnProperty.call(after, key);
    const from = inBefore ? before![key] : undefined;
    const to = inAfter ? after![key] : undefined;

    if (inBefore && inAfter) {
      if (jsonEqual(from, to)) continue;
      result.push({ key, from, to, kind: 'changed' });
    } else if (inAfter) {
      result.push({ key, from: undefined, to, kind: 'added' });
    } else {
      result.push({ key, from, to: undefined, kind: 'removed' });
    }
  }
  return result;
}
