'use client';

import type { FieldDraft, FieldType } from '@/lib/personalization/draft';
import { emptyFieldDraft, keyFromLabel } from '@/lib/personalization/draft';

/**
 * Секция «Персонализация» карточки товара.
 *
 * Здесь владелец описывает, что покупатель заполняет при заказе: сколько строк
 * гравировки, какой предел знаков, из каких значков выбирать. Это ОПИСАНИЕ, а
 * не сами надписи — надписи приходят с каждым заказом.
 *
 * Компонент намеренно тонкий: вся сборка и все проверки — в
 * `lib/personalization/draft.ts` (чистая функция под тестами). Здесь только
 * разметка и состояние, чтобы правила не разошлись с серверными.
 */

const TYPE_LABEL: Record<FieldType, string> = {
  text_lines: 'Несколько строк текста',
  text: 'Одна строка текста',
  select: 'Выбор из списка',
  color: 'Свой цвет (HEX)',
};

const TYPE_HINT: Record<FieldType, string> = {
  text_lines: 'Например, три строки гравировки: фамилия, имя, год.',
  text: 'Например, короткая надпись на обороте.',
  select: 'Например, значок вида: обруч, мяч, булавы.',
  color: 'Оттенок вне готовой палитры. Готовые цвета лучше заводить вариантами товара.',
};

export function PersonalizationSection({
  enabled,
  fields,
  onEnabledChange,
  onFieldsChange,
  error,
}: {
  enabled: boolean;
  fields: FieldDraft[];
  onEnabledChange: (value: boolean) => void;
  onFieldsChange: (value: FieldDraft[]) => void;
  /** Текст отказа сборки — показывается над списком, чтобы был виден до сабвита. */
  error?: string | null;
}) {
  function patch(index: number, part: Partial<FieldDraft>) {
    onFieldsChange(fields.map((f, i) => (i === index ? { ...f, ...part } : f)));
  }

  function addField() {
    onFieldsChange([...fields, emptyFieldDraft()]);
  }

  function removeField(index: number) {
    onFieldsChange(fields.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    onFieldsChange(next);
  }

  /**
   * Ключ фиксируется при первом уходе фокуса с подписи и дальше не меняется:
   * переименование подписи не должно менять контракт с витриной.
   */
  function fixKey(index: number) {
    const field = fields[index]!;
    if (field.key.trim() || !field.label.trim()) return;
    const taken = new Set(fields.map((f) => f.key).filter(Boolean));
    patch(index, { key: keyFromLabel(field.label, index, taken) });
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
        Персонализация — это то, что покупатель вписывает сам: надпись, значок,
        оттенок. Готовые цвета и размеры, у которых своя цена и свой остаток,
        заводятся <strong>вариантами</strong> товара, а не здесь.
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="font-medium text-gray-900">Покупатель заполняет поля при заказе</span>
      </label>

      {error ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {!enabled ? (
        <p className="text-sm text-gray-500">
          Товар продаётся как есть. Включите галочку, чтобы описать поля.
        </p>
      ) : (
        <>
          {fields.length === 0 ? (
            <p className="text-sm text-gray-500">Полей пока нет — добавьте первое.</p>
          ) : null}

          <ol className="space-y-4">
            {fields.map((field, index) => (
              <li key={index} className="rounded border border-gray-200 p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
                    Поле {index + 1}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
                      aria-label={`Поднять поле ${index + 1}`}
                    >
                      Выше
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === fields.length - 1}
                      className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
                      aria-label={`Опустить поле ${index + 1}`}
                    >
                      Ниже
                    </button>
                    <button
                      type="button"
                      onClick={() => removeField(index)}
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-700"
                    >
                      Удалить
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="mb-1 block text-gray-700">Что заполняет покупатель</span>
                    <select
                      value={field.type}
                      onChange={(e) => patch(index, { type: e.target.value as FieldType })}
                      className="w-full rounded border border-gray-300 px-2 py-1.5"
                    >
                      {(Object.keys(TYPE_LABEL) as FieldType[]).map((type) => (
                        <option key={type} value={type}>
                          {TYPE_LABEL[type]}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-xs text-gray-500">{TYPE_HINT[field.type]}</span>
                  </label>

                  <label className="block text-sm">
                    <span className="mb-1 block text-gray-700">Подпись поля на сайте</span>
                    <input
                      value={field.label}
                      onChange={(e) => patch(index, { label: e.target.value })}
                      onBlur={() => fixKey(index)}
                      placeholder="Гравировка"
                      className="w-full rounded border border-gray-300 px-2 py-1.5"
                    />
                  </label>

                  {field.type === 'text_lines' ? (
                    <label className="block text-sm">
                      <span className="mb-1 block text-gray-700">Сколько строк</span>
                      <input
                        value={field.lines}
                        onChange={(e) => patch(index, { lines: e.target.value })}
                        inputMode="numeric"
                        className="w-full rounded border border-gray-300 px-2 py-1.5"
                      />
                    </label>
                  ) : null}

                  {field.type === 'text' || field.type === 'text_lines' ? (
                    <label className="block text-sm">
                      <span className="mb-1 block text-gray-700">Знаков в строке, не больше</span>
                      <input
                        value={field.maxLength}
                        onChange={(e) => patch(index, { maxLength: e.target.value })}
                        inputMode="numeric"
                        className="w-full rounded border border-gray-300 px-2 py-1.5"
                      />
                      <span className="mt-1 block text-xs text-gray-500">
                        Предел проверяет сервер: длиннее просто не закажут.
                      </span>
                    </label>
                  ) : null}

                  {field.type === 'select' ? (
                    <>
                      <label className="block text-sm sm:col-span-2">
                        <span className="mb-1 block text-gray-700">Варианты, по одному в строке</span>
                        <textarea
                          value={field.options}
                          onChange={(e) => patch(index, { options: e.target.value })}
                          rows={5}
                          placeholder={'Обруч\nМяч\nБулавы'}
                          className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs"
                        />
                        <span className="mt-1 block text-xs text-gray-500">
                          Достаточно названий. Если нужен свой код для производства —
                          пишите «код|Название».
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={field.allowEmpty}
                          onChange={(e) => patch(index, { allowEmpty: e.target.checked })}
                          className="h-4 w-4"
                        />
                        <span className="text-gray-700">Можно ничего не выбирать</span>
                      </label>
                      {field.allowEmpty ? (
                        <label className="block text-sm">
                          <span className="mb-1 block text-gray-700">Как назвать пустой выбор</span>
                          <input
                            value={field.emptyLabel}
                            onChange={(e) => patch(index, { emptyLabel: e.target.value })}
                            placeholder="Без значка"
                            className="w-full rounded border border-gray-300 px-2 py-1.5"
                          />
                        </label>
                      ) : null}
                    </>
                  ) : null}

                  <label className="block text-sm sm:col-span-2">
                    <span className="mb-1 block text-gray-700">Подсказка под полем (необязательно)</span>
                    <input
                      value={field.hint}
                      onChange={(e) => patch(index, { hint: e.target.value })}
                      className="w-full rounded border border-gray-300 px-2 py-1.5"
                    />
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => patch(index, { required: e.target.checked })}
                      className="h-4 w-4"
                    />
                    <span className="text-gray-700">Обязательно к заполнению</span>
                  </label>
                </div>
              </li>
            ))}
          </ol>

          <button
            type="button"
            onClick={addField}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Добавить поле
          </button>
        </>
      )}
    </div>
  );
}
