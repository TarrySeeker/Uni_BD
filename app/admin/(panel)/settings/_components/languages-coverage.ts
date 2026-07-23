/**
 * Матрица покрытия переводов для экрана «Языки» (T3) — слой представления над
 * computeCoverage (lib/i18n/coverage.ts). Чистые функции: страница передаёт уже
 * посчитанные CoverageResult по сущностям, здесь они превращаются в строки
 * таблицы «сущность × язык» с процентами.
 *
 * Толерантность к пропускам: если в CoverageResult нет запрошенного языка
 * (например, язык только что включили и покрытие считалось без него), ячейка
 * показывает 0 %, а не роняет страницу.
 */

import type { CoverageResult, FieldCoverage } from '@/lib/i18n/coverage';
import type { Locale } from '@/lib/i18n/types';

/** Вход: посчитанное покрытие по одной сущности. */
export interface CoverageEntry {
  entity: string;
  label: string;
  coverage: CoverageResult;
}

/** Покрытие одного поля с готовым процентом. */
export interface CoverageFieldCell extends FieldCoverage {
  percent: number;
}

/** Ячейка «сущность × язык». */
export interface CoverageCell {
  locale: Locale;
  filled: number;
  missing: number;
  ratio: number;
  percent: number;
  fields: Record<string, CoverageFieldCell>;
}

/** Строка матрицы: одна сущность. */
export interface CoverageRow {
  entity: string;
  label: string;
  total: number;
  cells: CoverageCell[];
}

const EMPTY_FIELD: FieldCoverage = { filled: 0, missing: 0, ratio: 0 };

/** Доля 0..1 → целые проценты. */
export function percentOf(ratio: number): number {
  return Math.round((Number.isFinite(ratio) ? ratio : 0) * 100);
}

/** Подпись процента для UI. */
export function formatPercent(ratio: number): string {
  return `${percentOf(ratio)} %`;
}

/** Градация заполненности — для цветовой подсветки ячейки. */
export function coverageTone(ratio: number): 'none' | 'low' | 'mid' | 'full' {
  if (ratio <= 0) return 'none';
  if (ratio >= 1) return 'full';
  return ratio < 0.5 ? 'low' : 'mid';
}

/** Собирает матрицу покрытия: строка на сущность, ячейка на язык. */
export function buildCoverageMatrix(
  entries: readonly CoverageEntry[],
  locales: readonly Locale[],
): CoverageRow[] {
  return entries.map((entry) => ({
    entity: entry.entity,
    label: entry.label,
    total: entry.coverage.total,
    cells: locales.map((locale) => {
      const localeCoverage = entry.coverage.locales[locale];
      const overall = localeCoverage?.overall ?? EMPTY_FIELD;
      const fields: Record<string, CoverageFieldCell> = {};
      for (const [field, value] of Object.entries(localeCoverage?.fields ?? {})) {
        fields[field] = { ...value, percent: percentOf(value.ratio) };
      }
      return {
        locale,
        filled: overall.filled,
        missing: overall.missing,
        ratio: overall.ratio,
        percent: percentOf(overall.ratio),
        fields,
      };
    }),
  }));
}
