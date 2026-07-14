/**
 * Матрица покрытия переводов (ADR-i18n, docs/24 §1) — для дашборда «Языки».
 *
 * computeCoverage(rows, locales, fields) считает, сколько строк имеют заполненное
 * значение по каждому (язык × поле) в оверлее translations. Язык по умолчанию
 * обычно НЕ передаётся (он хранится в базовых колонках, а не в оверлее). Чистая
 * функция, без БД/Next.
 */

import type { Locale, TranslationsMap } from './types';
import { isNonEmptyValue } from './resolve';

export interface FieldCoverage {
  filled: number;
  missing: number;
  /** Доля заполненности 0..1 (0, если строк нет). */
  ratio: number;
}

export interface LocaleCoverage {
  fields: Record<string, FieldCoverage>;
  overall: FieldCoverage;
}

export interface CoverageResult {
  /** Всего строк в выборке. */
  total: number;
  locales: Record<Locale, LocaleCoverage>;
}

function ratio(filled: number, total: number): number {
  return total === 0 ? 0 : filled / total;
}

export function computeCoverage(
  rows: ReadonlyArray<{ translations?: TranslationsMap | null }>,
  locales: readonly Locale[],
  fields: readonly string[],
): CoverageResult {
  const total = rows.length;
  const result: CoverageResult = { total, locales: {} };

  for (const locale of locales) {
    const fieldCov: Record<string, FieldCoverage> = {};
    let overallFilled = 0;

    for (const field of fields) {
      let filled = 0;
      for (const row of rows) {
        const overlay = row.translations?.[locale];
        if (overlay && isNonEmptyValue(overlay[field])) {
          filled += 1;
        }
      }
      fieldCov[field] = { filled, missing: total - filled, ratio: ratio(filled, total) };
      overallFilled += filled;
    }

    const overallTotal = total * fields.length;
    result.locales[locale] = {
      fields: fieldCov,
      overall: {
        filled: overallFilled,
        missing: overallTotal - overallFilled,
        ratio: ratio(overallFilled, overallTotal),
      },
    };
  }

  return result;
}
