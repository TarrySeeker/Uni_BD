'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { SizeChartsSettings } from '@/lib/settings/schemas';

import {
  buildSizeChartsPayload,
  chartsToFormState,
  emptyChartDraft,
  emptyColumnDraft,
  emptyRowDraft,
  type SizeChartDraft,
  type SizeChartsFormState,
} from '@/lib/settings/size-charts-form';
import { updateSizeChartsSettingAction } from './form-actions';
import { errorMessage } from './action-result';
import { ResetSettingButton } from './ResetSettingButton';

/**
 * Форма «Размерные сетки» (ключ настроек size_charts).
 *
 * Табличный редактор: произвольное число сеток, у каждой — произвольный набор
 * КОЛОНОК (key/label) и строк. Ничего не зашито в код: новый магазин заводит
 * свои сетки настройкой, а не правкой кода (мультитенантность).
 *
 * Сборка значения — чистым buildSizeChartsPayload (lib/settings/size-charts-form,
 * покрыт tests/settings/size-charts-form.test.ts). Мутация —
 * updateSizeChartsSettingAction (settings.manage → sizeChartsSchema → upsert
 * 'size_charts' → audit). Валидация на бэкенде: дубли id и превышения лимитов
 * вернутся ошибкой валидации.
 *
 * Удаление сетки/колонки/строки подтверждается window.confirm (модалок в
 * админке нет как класса).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
const cellCls = 'w-full rounded border border-gray-300 px-2 py-1 text-sm';
const labelCls = 'block text-sm font-medium text-gray-700';
const hintCls = 'mt-1 text-xs text-gray-500';
const btnCls =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50';
const dangerBtnCls =
  'rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50';

/** Свободный id для новой сетки: chart-1, chart-2, … (не занятый в форме). */
function nextChartId(charts: SizeChartDraft[]): string {
  const taken = new Set(charts.map((c) => c.id.trim()));
  let n = charts.length + 1;
  while (taken.has(`chart-${n}`)) n += 1;
  return `chart-${n}`;
}

export function SizeChartsForm({ sizeCharts }: { sizeCharts: SizeChartsSettings }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<SizeChartsFormState>(() => chartsToFormState(sizeCharts));

  /** Точечное обновление одной сетки (иммутабельно, порядок сохраняется). */
  function patchChart(index: number, patch: Partial<SizeChartDraft>) {
    setState((prev) => ({
      ...prev,
      charts: prev.charts.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function addChart() {
    setState((prev) => ({
      ...prev,
      charts: [...prev.charts, emptyChartDraft(nextChartId(prev.charts))],
    }));
  }

  function removeChart(index: number) {
    const title = state.charts[index]?.title || state.charts[index]?.id || 'без названия';
    if (!window.confirm(`Удалить размерную сетку «${title}»?`)) return;
    setState((prev) => ({ ...prev, charts: prev.charts.filter((_, i) => i !== index) }));
  }

  function addColumn(chartIndex: number) {
    const chart = state.charts[chartIndex];
    if (!chart) return;
    patchChart(chartIndex, {
      columns: [...chart.columns, emptyColumnDraft()],
      // Каждая строка получает ячейку под новую колонку.
      rows: chart.rows.map((cells) => [...cells, '']),
    });
  }

  function removeColumn(chartIndex: number, colIndex: number) {
    const chart = state.charts[chartIndex];
    if (!chart) return;
    if (!window.confirm('Удалить колонку вместе со значениями во всех строках?')) return;
    patchChart(chartIndex, {
      columns: chart.columns.filter((_, i) => i !== colIndex),
      rows: chart.rows.map((cells) => cells.filter((_, i) => i !== colIndex)),
    });
  }

  function patchColumn(chartIndex: number, colIndex: number, patch: { key?: string; label?: string }) {
    const chart = state.charts[chartIndex];
    if (!chart) return;
    patchChart(chartIndex, {
      columns: chart.columns.map((c, i) => (i === colIndex ? { ...c, ...patch } : c)),
    });
  }

  function addRow(chartIndex: number) {
    const chart = state.charts[chartIndex];
    if (!chart) return;
    patchChart(chartIndex, { rows: [...chart.rows, emptyRowDraft(chart.columns.length)] });
  }

  function removeRow(chartIndex: number, rowIndex: number) {
    const chart = state.charts[chartIndex];
    if (!chart) return;
    if (!window.confirm('Удалить строку размерной сетки?')) return;
    patchChart(chartIndex, { rows: chart.rows.filter((_, i) => i !== rowIndex) });
  }

  function patchCell(chartIndex: number, rowIndex: number, colIndex: number, value: string) {
    const chart = state.charts[chartIndex];
    if (!chart) return;
    patchChart(chartIndex, {
      rows: chart.rows.map((cells, i) =>
        i === rowIndex ? cells.map((cell, j) => (j === colIndex ? value : cell)) : cells,
      ),
    });
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateSizeChartsSettingAction({
      sizeCharts: buildSizeChartsPayload(state),
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Размерные сетки сохранены.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <p className="mb-5 text-sm text-gray-600">
        Таблицы размеров на карточке товара. Набор колонок произвольный — задайте
        те мерки, которые нужны вашему магазину. Поле «Полы» связывает сетку со
        значением атрибута товара «пол»: если оно пустое, сетка подходит всегда, а
        если для товара не подошла ни одна сетка — покупателю показываются все.
      </p>

      {state.charts.length === 0 ? (
        <p className="mb-5 rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500">
          Сеток пока нет. Пока список пуст, блок «Размерная сетка» на витрине не
          показывается.
        </p>
      ) : null}

      {state.charts.map((chart, chartIndex) => (
        <fieldset key={chartIndex} className="mb-6 rounded border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-800">
            Сетка {chartIndex + 1}
            {chart.title ? `: ${chart.title}` : ''}
          </legend>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`chart-${chartIndex}-title`} className={labelCls}>Название</label>
              <input id={`chart-${chartIndex}-title`} value={chart.title}
                onChange={(e) => patchChart(chartIndex, { title: e.target.value })}
                className={inputCls} placeholder="Женская размерная сетка" />
            </div>
            <div>
              <label htmlFor={`chart-${chartIndex}-id`} className={labelCls}>Идентификатор (латиницей)</label>
              <input id={`chart-${chartIndex}-id`} value={chart.id}
                onChange={(e) => patchChart(chartIndex, { id: e.target.value })}
                className={`${inputCls} font-mono`} placeholder="women" />
              <p className={hintCls}>Должен быть уникальным среди сеток.</p>
            </div>
            <div>
              <label htmlFor={`chart-${chartIndex}-note`} className={labelCls}>Примечание (необязательно)</label>
              <input id={`chart-${chartIndex}-note`} value={chart.note}
                onChange={(e) => patchChart(chartIndex, { note: e.target.value })}
                className={inputCls} placeholder="подпись под заголовком сетки" />
            </div>
            <div>
              <label htmlFor={`chart-${chartIndex}-genders`} className={labelCls}>Полы (через запятую)</label>
              <input id={`chart-${chartIndex}-genders`} value={chart.gendersText}
                onChange={(e) => patchChart(chartIndex, { gendersText: e.target.value })}
                className={inputCls} placeholder="women, женский, жен" />
              <p className={hintCls}>Пусто — сетка подходит любому товару.</p>
            </div>
          </div>

          {/* Колонки: идентификатор ячейки + подпись в таблице. */}
          <div className="mt-5">
            <p className={labelCls}>Колонки таблицы</p>
            <p className={hintCls}>
              «Ключ» — латиницей, идентификатор ячейки; «Подпись» видит покупатель.
              Ключи должны различаться внутри сетки.
            </p>
            <div className="mt-2 space-y-2">
              {chart.columns.map((col, colIndex) => (
                <div key={colIndex} className="flex flex-wrap items-center gap-2">
                  <input aria-label={`Ключ колонки ${colIndex + 1}`} value={col.key}
                    onChange={(e) => patchColumn(chartIndex, colIndex, { key: e.target.value })}
                    className={`${cellCls} font-mono sm:w-40`} placeholder="chest" />
                  <input aria-label={`Подпись колонки ${colIndex + 1}`} value={col.label}
                    onChange={(e) => patchColumn(chartIndex, colIndex, { label: e.target.value })}
                    className={`${cellCls} sm:w-64`} placeholder="заголовок колонки" />
                  <button type="button" onClick={() => removeColumn(chartIndex, colIndex)} className={dangerBtnCls}>
                    Удалить колонку
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => addColumn(chartIndex)} className={`${btnCls} mt-2`}>
              + Колонка
            </button>
          </div>

          {/* Строки: ячейки по колонкам. */}
          <div className="mt-5">
            <p className={labelCls}>Строки</p>
            {chart.columns.length === 0 ? (
              <p className={hintCls}>Сначала добавьте хотя бы одну колонку.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr>
                      {chart.columns.map((col, colIndex) => (
                        <th key={colIndex} className="px-2 py-1 text-left text-xs font-medium text-gray-500">
                          {col.label || col.key || `Колонка ${colIndex + 1}`}
                        </th>
                      ))}
                      <th className="px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {chart.rows.map((cells, rowIndex) => (
                      <tr key={rowIndex}>
                        {chart.columns.map((col, colIndex) => (
                          <td key={colIndex} className="px-2 py-1">
                            <input
                              aria-label={`Строка ${rowIndex + 1}, ${col.label || col.key || colIndex + 1}`}
                              value={cells[colIndex] ?? ''}
                              onChange={(e) => patchCell(chartIndex, rowIndex, colIndex, e.target.value)}
                              className={cellCls}
                            />
                          </td>
                        ))}
                        <td className="px-2 py-1">
                          <button type="button" onClick={() => removeRow(chartIndex, rowIndex)} className={dangerBtnCls}>
                            Удалить
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <button type="button" onClick={() => addRow(chartIndex)} disabled={chart.columns.length === 0}
              className={`${btnCls} mt-2`}>
              + Строка
            </button>
          </div>

          <div className="mt-5 border-t border-gray-200 pt-3">
            <button type="button" onClick={() => removeChart(chartIndex)} className={dangerBtnCls}>
              Удалить сетку
            </button>
          </div>
        </fieldset>
      ))}

      <button type="button" onClick={addChart} className={btnCls}>
        + Размерная сетка
      </button>

      <div className="mt-6">
        <label htmlFor="size-charts-footnote" className={labelCls}>Общая сноска под таблицей</label>
        <input id="size-charts-footnote" value={state.footnote}
          onChange={(e) => setState((prev) => ({ ...prev, footnote: e.target.value }))}
          className={inputCls} placeholder="общее примечание, показывается под всеми сетками" />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить размерные сетки'}
        </button>
        <ResetSettingButton settingKey="size_charts" label="Сбросить размерные сетки" />
      </div>
    </div>
  );
}
