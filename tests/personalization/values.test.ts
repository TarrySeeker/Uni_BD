import { describe, expect, it } from 'vitest';

import { parseSpec, validateValues } from '@/lib/personalization/schemas';

/**
 * Тесты ЗНАЧЕНИЙ персонализации — того, что присылает покупатель.
 *
 * Ключевой инвариант: значения проверяет СЕРВЕР по описанию товара из БД.
 * Storefront API — обычный HTTP-эндпоинт, и «из формы такое не придёт» защитой
 * не является (docs/32 §8, класс stored XSS). Поэтому проверяются пределы длины,
 * число строк, принадлежность варианта списку и отсутствие лишних ключей.
 */

const spec = parseSpec({
  fields: [
    {
      key: 'front',
      type: 'text_lines',
      label: 'Гравировка',
      lines: 3,
      maxLength: 10,
      required: true,
    },
    { key: 'back', type: 'text_lines', label: 'Оборот', lines: 2, maxLength: 10 },
    {
      key: 'sign',
      type: 'select',
      label: 'Знак',
      options: [{ value: 'hoop', label: 'Обруч' }],
      allowEmpty: true,
    },
    { key: 'shade', type: 'color', label: 'Оттенок' },
  ],
})!;

describe('personalization/values — валидные значения', () => {
  it('принимает заполненные строки, выбранный вариант и HEX', () => {
    const r = validateValues(spec, {
      front: ['Иванова', 'Амелия', '2017'],
      sign: 'hoop',
      shade: '#C0332B',
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.values.front).toEqual(['Иванова', 'Амелия', '2017']);
  });

  it('обрезает пробелы по краям — иначе они уедут в гравировку', () => {
    const r = validateValues(spec, { front: ['  Иванова  ', '', ''] });
    expect(r.ok && r.values.front).toEqual(['Иванова', '', '']);
  });

  it('необязательное поле можно не присылать вовсе', () => {
    const r = validateValues(spec, { front: ['Иванова'] });
    expect(r.ok).toBe(true);
  });

  it('пустой выбор допустим, когда allowEmpty', () => {
    expect(validateValues(spec, { front: ['Иванова'], sign: '' }).ok).toBe(true);
  });

  it('отсутствующее описание (undefined) не роняет проверку', () => {
    // Регрессия: колонки могло не быть у объекта вовсе (старый маппер, мок,
    // частичная выборка) — падение здесь означало 500 на создании заказа.
    expect(validateValues(undefined, {}).ok).toBe(true);
    expect(validateValues(undefined, { front: ['Иванова'] }).ok).toBe(false);
  });

  it('товар без персонализации принимает только пустой объект', () => {
    expect(validateValues(null, {}).ok).toBe(true);
    const r = validateValues(null, { front: ['Иванова'] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/не персонализируется/i);
  });
});

describe('personalization/values — отказы', () => {
  it('обязательное поле не может быть пустым во всех строках', () => {
    const r = validateValues(spec, { front: ['', '', ''] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/Гравировка/);
  });

  it('обязательное поле нельзя пропустить', () => {
    expect(validateValues(spec, { sign: 'hoop' }).ok).toBe(false);
  });

  it('строк не может быть больше, чем объявлено', () => {
    const r = validateValues(spec, { front: ['а', 'б', 'в', 'г'] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/строк/i);
  });

  it('строка длиннее предела отклоняется, а не обрезается молча', () => {
    // Молчаливая обрезка — это «сохранено», после которого покупатель получит
    // не то, что заказывал (docs/32 §3, формы, теряющие данные).
    const r = validateValues(spec, { front: ['ЭтоСлишкомДлиннаяСтрока'] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/10/);
  });

  it('вариант вне списка отклоняется', () => {
    expect(validateValues(spec, { front: ['Иванова'], sign: 'ribbon' }).ok).toBe(false);
  });

  it('не-HEX в поле цвета отклоняется', () => {
    expect(validateValues(spec, { front: ['Иванова'], shade: 'красный' }).ok).toBe(false);
    expect(validateValues(spec, { front: ['Иванова'], shade: '#GGGGGG' }).ok).toBe(false);
  });

  it('лишний ключ отклоняется, а не проходит молча', () => {
    // Молчаливое отбрасывание — это класс «Zod-схема тихо выкинула поле»
    // (docs/32 §2): владелец видит одно, в БД лежит другое.
    const r = validateValues(spec, { front: ['Иванова'], hack: 'x' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/hack/);
  });

  it('строки должны быть строками, а не числами или объектами', () => {
    expect(validateValues(spec, { front: [17] as unknown as string[] }).ok).toBe(false);
    expect(validateValues(spec, { front: 'Иванова' as unknown as string[] }).ok).toBe(false);
  });

  it('управляющие символы и перевод строки отклоняются', () => {
    // Гравируется одна строка; перевод строки внутри неё — это либо вставка из
    // буфера, либо попытка сломать печатную форму.
    expect(validateValues(spec, { front: ['Ива\nнова'] }).ok).toBe(false);
    expect(validateValues(spec, { front: ['Ива\tнова'] }).ok).toBe(false);
    // Пробел внутри строки — норма: «5 «Б»», «с любовью», «г. Ростов-на-Дону».
    expect(validateValues(spec, { front: ['с любовью'] }).ok).toBe(true);
  });

  it('значения не объект — отказ, а не падение', () => {
    expect(validateValues(spec, null as unknown as Record<string, unknown>).ok).toBe(false);
    expect(validateValues(spec, [] as unknown as Record<string, unknown>).ok).toBe(false);
  });
});

describe('personalization/values — нормализация снимка', () => {
  it('в снимок попадают только объявленные поля, порядок — как в описании', () => {
    const r = validateValues(spec, { sign: 'hoop', front: ['Иванова'] });
    expect(r.ok && Object.keys(r.values)).toEqual(['front', 'sign']);
  });

  it('хвостовые пустые строки не отбрасываются: их место значимо', () => {
    // «Иванова / пусто / 2017» — не то же самое, что «Иванова / 2017»:
    // на изделии это разные строки гравировки.
    const r = validateValues(spec, { front: ['Иванова', '', '2017'] });
    expect(r.ok && r.values.front).toEqual(['Иванова', '', '2017']);
  });
});
