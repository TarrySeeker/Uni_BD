import { describe, expect, it } from 'vitest';

import {
  buildSpecFromDraft,
  draftFromSpec,
  emptyFieldDraft,
  keyFromLabel,
  type FieldDraft,
} from '@/lib/personalization/draft';
import { parseSpec } from '@/lib/personalization/schemas';

/**
 * Сборка описания персонализации из формы товара.
 *
 * Ключевое требование — ГРОМКИЙ отказ: неполное поле останавливает сохранение с
 * понятным текстом, а не выбрасывается молча (docs/32 §3 — репитер, который
 * рапортовал «сохранено» и терял строку).
 */

function draft(over: Partial<FieldDraft> = {}): FieldDraft {
  return { ...emptyFieldDraft(), label: 'Надпись', ...over };
}

describe('personalization/draft — выключенная персонализация', () => {
  it('выключено → описания нет, черновик не мешает', () => {
    const r = buildSpecFromDraft(false, [draft(), draft({ label: '' })]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec).toBeNull();
  });

  it('включено без полей → отказ с подсказкой, что делать', () => {
    const r = buildSpecFromDraft(true, []);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/выключите/i);
  });
});

describe('personalization/draft — сборка полей', () => {
  it('собирает многострочное поле с пределами', () => {
    const r = buildSpecFromDraft(true, [
      draft({ label: 'Гравировка', lines: '3', maxLength: '20', required: true }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec!.fields[0]).toMatchObject({
      type: 'text_lines',
      label: 'Гравировка',
      lines: 3,
      maxLength: 20,
      required: true,
    });
  });

  it('ключ выводится из подписи транслитерацией — владелец его не вводит', () => {
    const r = buildSpecFromDraft(true, [draft({ label: 'Гравировка' })]);
    expect(r.ok && r.spec!.fields[0]!.key).toBe('gravirovka');
  });

  it('заданный ключ не пересчитывается: переименование подписи не меняет контракт', () => {
    const r = buildSpecFromDraft(true, [draft({ key: 'front', label: 'Совсем другая подпись' })]);
    expect(r.ok && r.spec!.fields[0]!.key).toBe('front');
  });

  it('одинаковые подписи дают разные ключи, а не затирают друг друга', () => {
    const r = buildSpecFromDraft(true, [draft({ label: 'Строка' }), draft({ label: 'Строка' })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = r.spec!.fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('подпись из одних знаков препинания всё равно даёт валидный ключ', () => {
    const r = buildSpecFromDraft(true, [draft({ label: '«»' })]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec!.fields[0]!.key).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('personalization/draft — громкие отказы вместо потери данных', () => {
  it('поле без подписи останавливает сохранение и называет его номер', () => {
    const r = buildSpecFromDraft(true, [draft(), draft({ label: '   ' })]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/Поле 2/);
  });

  it('пустой предел знаков — отказ, а не «ноль знаков»', () => {
    const r = buildSpecFromDraft(true, [draft({ maxLength: '' })]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/предел знаков/i);
  });

  it('нецелый или отрицательный предел — отказ', () => {
    expect(buildSpecFromDraft(true, [draft({ maxLength: '2,5' })]).ok).toBe(false);
    expect(buildSpecFromDraft(true, [draft({ maxLength: '-3' })]).ok).toBe(false);
    expect(buildSpecFromDraft(true, [draft({ lines: '0' })]).ok).toBe(false);
  });

  it('select без вариантов — отказ', () => {
    const r = buildSpecFromDraft(true, [draft({ type: 'select', label: 'Знак', options: '  ' })]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/вариант/i);
  });
});

describe('personalization/draft — варианты выбора', () => {
  it('строка «код|подпись» разбирается в вариант', () => {
    const r = buildSpecFromDraft(true, [
      draft({ type: 'select', label: 'Знак', options: 'hoop|Обруч\nball|Мяч' }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const field = r.spec!.fields[0];
    expect(field!.type === 'select' && field!.options).toEqual([
      { value: 'hoop', label: 'Обруч' },
      { value: 'ball', label: 'Мяч' },
    ]);
  });

  it('без кода он выводится из подписи — владельцу достаточно написать список', () => {
    const r = buildSpecFromDraft(true, [
      draft({ type: 'select', label: 'Знак', options: 'Обруч\nМяч' }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const field = r.spec!.fields[0];
    expect(field!.type === 'select' && field!.options.map((o) => o.value)).toEqual([
      'obruch',
      'myach',
    ]);
  });

  it('повторяющийся код варианта — отказ', () => {
    const r = buildSpecFromDraft(true, [
      draft({ type: 'select', label: 'Знак', options: 'hoop|Обруч\nhoop|Другое' }),
    ]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/повторя/i);
  });

  it('пустые строки в списке вариантов игнорируются, а не ломают разбор', () => {
    const r = buildSpecFromDraft(true, [
      draft({ type: 'select', label: 'Знак', options: 'Обруч\n\n\nМяч\n' }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const field = r.spec!.fields[0];
    expect(field!.type === 'select' && field!.options).toHaveLength(2);
  });
});

describe('personalization/draft — обратное преобразование', () => {
  it('описание → черновик → описание не теряет ничего', () => {
    const spec = parseSpec({
      fields: [
        { key: 'front', type: 'text_lines', label: 'Лицо', lines: 3, maxLength: 20, required: true },
        {
          key: 'sign',
          type: 'select',
          label: 'Знак',
          options: [{ value: 'hoop', label: 'Обруч' }],
          allowEmpty: true,
          emptyLabel: 'Без знака',
        },
        { key: 'shade', type: 'color', label: 'Оттенок', required: false },
        { key: 'note', type: 'text', label: 'Заметка', maxLength: 40, hint: 'по желанию' },
      ],
    })!;

    const rebuilt = buildSpecFromDraft(true, draftFromSpec(spec));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.ok && rebuilt.spec).toEqual(spec);
  });

  it('пустое описание даёт пустой черновик', () => {
    expect(draftFromSpec(null)).toEqual([]);
  });
});

describe('personalization/draft — keyFromLabel', () => {
  it('не начинается с цифры: ключ должен быть идентификатором', () => {
    expect(keyFromLabel('2017 год', 0, new Set())).toMatch(/^[a-z]/);
  });

  it('разводит занятые ключи суффиксом', () => {
    const taken = new Set(['nadpis']);
    expect(keyFromLabel('Надпись', 0, taken)).not.toBe('nadpis');
  });
});
