import type { SizeChartsSettings } from './schemas';

/**
 * Чистая логика UI-формы «Размерные сетки» (ключ настроек `size_charts`).
 *
 * Форма редактирует ПРОИЗВОЛЬНЫЕ сетки с ПРОИЗВОЛЬНЫМ набором колонок — в коде
 * не зашито ни одной колонки и ни одной сетки конкретного магазина
 * (мультитенантность: новый магазин настраивается, а не правится кодом).
 *
 * Здесь только маппинг «состояние формы ⇄ значение настройки», без React и без
 * БД, чтобы покрыть юнит-тестом (vitest environment=node, RTL в проекте нет).
 * Валидацию делает Zod на бэкенде (sizeChartsSchema через
 * updateSizeChartsAction) — форма отправляет то, что ввёл владелец, и
 * показывает ошибку валидации. В частности, дубли `id` НЕ «чинятся» здесь:
 * их отвергает .refine схемы, и владелец видит ошибку, а не молчаливую потерю
 * одной из сеток.
 *
 * Строки хранятся в форме как массив ячеек ПО ИНДЕКСУ колонки (string[][]), а
 * не по ключу: это позволяет переименовать `key` колонки, не теряя данные —
 * привязка к ключам происходит только в момент сборки значения.
 */

/** Колонка в форме: идентификатор ячейки + человеческая подпись. */
export interface SizeChartColumnDraft {
  key: string;
  label: string;
}

/** Одна сетка в форме. `rows[i][j]` — ячейка строки i под колонкой j. */
export interface SizeChartDraft {
  id: string;
  title: string;
  /** Пустая строка = сноски у сетки нет (в значение поле не попадёт). */
  note: string;
  /** Полы через запятую/перенос строки. Пусто = «сетка применима всегда». */
  gendersText: string;
  columns: SizeChartColumnDraft[];
  rows: string[][];
}

/** Полное состояние формы. */
export interface SizeChartsFormState {
  charts: SizeChartDraft[];
  /** Пустая строка = общей сноски нет (в значение поле не попадёт). */
  footnote: string;
}

/** Пустая колонка — key/label заполняет владелец. */
export function emptyColumnDraft(): SizeChartColumnDraft {
  return { key: '', label: '' };
}

/** Черновик новой сетки: одна пустая колонка, строк ещё нет. */
export function emptyChartDraft(id: string): SizeChartDraft {
  return {
    id,
    title: '',
    note: '',
    gendersText: '',
    columns: [emptyColumnDraft()],
    rows: [],
  };
}

/** Текстовое поле полов → массив значений (запятая или перенос строки). */
export function parseGendersText(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Пустая строка ячеек нужной ширины (при добавлении строки таблицы). */
export function emptyRowDraft(columnCount: number): string[] {
  return Array.from({ length: columnCount }, () => '');
}

/**
 * Состояние формы → значение настройки `size_charts` по общему контракту.
 *
 * Правила (проверены тестами):
 *  - всё тримится;
 *  - сетка без id И без title отбрасывается (случайно добавленная пустая);
 *  - колонка без key И без label отбрасывается вместе со своими ячейками;
 *  - строка, где все ячейки пустые, отбрасывается; пустые ячейки в остальных
 *    строках в значение не попадают (витрина рисует пропуск как пустую ячейку);
 *  - пустые `note`/`footnote` ОТСУТСТВУЮТ в объекте (не null, не '') — так же,
 *    как их описывает PublicSettingsDto (`note?: string`);
 *  - порядок сеток / колонок / строк сохраняется.
 */
export function buildSizeChartsPayload(state: SizeChartsFormState): SizeChartsSettings {
  const charts = state.charts
    .map((chart) => {
      const id = chart.id.trim();
      const title = chart.title.trim();
      if (!id && !title) return null;

      // Индексы колонок, которые попадут в значение (остальные — «мусорные»).
      const keptColumns: { index: number; key: string; label: string }[] = [];
      chart.columns.forEach((col, index) => {
        const key = col.key.trim();
        const label = col.label.trim();
        if (!key && !label) return;
        keptColumns.push({ index, key, label });
      });

      const rows = chart.rows
        .map((cells) => {
          const row: Record<string, string> = {};
          for (const col of keptColumns) {
            const cell = (cells[col.index] ?? '').trim();
            if (cell.length > 0) row[col.key] = cell;
          }
          return row;
        })
        .filter((row) => Object.keys(row).length > 0);

      const note = chart.note.trim();

      return {
        id,
        title,
        ...(note ? { note } : {}),
        genders: parseGendersText(chart.gendersText),
        columns: keptColumns.map((c) => ({ key: c.key, label: c.label })),
        rows,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const footnote = state.footnote.trim();

  return {
    charts,
    ...(footnote ? { footnote } : {}),
  } as SizeChartsSettings;
}

/** Значение настройки (эффективное) → состояние формы для редактирования. */
export function chartsToFormState(value: SizeChartsSettings): SizeChartsFormState {
  return {
    charts: (value.charts ?? []).map((chart) => ({
      id: chart.id,
      title: chart.title,
      note: chart.note ?? '',
      gendersText: (chart.genders ?? []).join(', '),
      columns: (chart.columns ?? []).map((c) => ({ key: c.key, label: c.label })),
      rows: (chart.rows ?? []).map((row) =>
        (chart.columns ?? []).map((c) => row[c.key] ?? ''),
      ),
    })),
    footnote: value.footnote ?? '',
  };
}
