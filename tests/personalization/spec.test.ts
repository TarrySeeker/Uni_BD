import { describe, expect, it } from 'vitest';

import {
  PersonalizationSpecSchema,
  describePersonalization,
  isPersonalized,
  parseSpec,
} from '@/lib/personalization/schemas';

/**
 * Тесты ОПИСАНИЯ персонализации — того, что владелец задаёт в карточке товара
 * (какие поля заполняет покупатель). Без БД, всегда зелёные.
 *
 * Механизм универсальный: гравировка на флешке, имя на футболке, надпись на
 * кружке — это одни и те же типы полей. Поэтому в тестах намеренно разные ниши:
 * привязка к одной сломала бы мультитенантность (CLAUDE.md).
 */

const gymnastics = {
  fields: [
    {
      key: 'front',
      type: 'text_lines',
      label: 'Гравировка, лицевая сторона',
      lines: 3,
      maxLength: 20,
      required: true,
    },
    {
      key: 'apparatus',
      type: 'select',
      label: 'Знак вида',
      options: [
        { value: 'hoop', label: 'Обруч' },
        { value: 'ball', label: 'Мяч' },
      ],
      allowEmpty: true,
      emptyLabel: 'Без знака',
    },
  ],
};

describe('personalization/spec — разбор описания полей', () => {
  it('принимает корректное описание и возвращает поля по порядку', () => {
    const parsed = PersonalizationSpecSchema.safeParse(gymnastics);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.fields.map((f) => f.key)).toEqual(['front', 'apparatus']);
  });

  it('принимает одиночное текстовое поле (надпись на кружке — другая ниша)', () => {
    const mug = {
      fields: [{ key: 'text', type: 'text', label: 'Надпись', maxLength: 40, required: true }],
    };
    expect(PersonalizationSpecSchema.safeParse(mug).success).toBe(true);
  });

  it('принимает выбор цвета произвольным HEX (когда палитры недостаточно)', () => {
    const spec = {
      fields: [{ key: 'shade', type: 'color', label: 'Свой оттенок', required: false }],
    };
    expect(PersonalizationSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('отклоняет описание без полей: товар либо персонализируется, либо нет', () => {
    expect(PersonalizationSpecSchema.safeParse({ fields: [] }).success).toBe(false);
  });

  it('отклоняет повторяющийся ключ — иначе одно значение затрёт другое', () => {
    const dup = {
      fields: [
        { key: 'text', type: 'text', label: 'Строка 1', maxLength: 10 },
        { key: 'text', type: 'text', label: 'Строка 2', maxLength: 10 },
      ],
    };
    const parsed = PersonalizationSpecSchema.safeParse(dup);
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toMatch(/повтор/i);
  });

  it('отклоняет неизвестный тип поля', () => {
    const bad = { fields: [{ key: 'x', type: 'signature', label: 'Подпись' }] };
    expect(PersonalizationSpecSchema.safeParse(bad).success).toBe(false);
  });

  it('отклоняет select без вариантов — выбирать было бы не из чего', () => {
    const bad = { fields: [{ key: 'x', type: 'select', label: 'Знак', options: [] }] };
    expect(PersonalizationSpecSchema.safeParse(bad).success).toBe(false);
  });

  it('отклоняет ключ не из латиницы: он уходит в JSON и в печать', () => {
    const bad = { fields: [{ key: 'знак', type: 'text', label: 'Знак', maxLength: 5 }] };
    expect(PersonalizationSpecSchema.safeParse(bad).success).toBe(false);
  });
});

describe('personalization/spec — parseSpec и isPersonalized', () => {
  it('parseSpec возвращает null для NULL из БД (товар без персонализации)', () => {
    expect(parseSpec(null)).toBeNull();
    expect(parseSpec(undefined)).toBeNull();
  });

  it('parseSpec возвращает null для битого значения, а не бросает', () => {
    // Карточка товара не должна падать целиком из-за мусора в одной колонке:
    // владелец увидит «персонализации нет» и сможет задать её заново.
    expect(parseSpec({ fields: 'что-то не то' })).toBeNull();
    expect(parseSpec('строка')).toBeNull();
  });

  it('isPersonalized различает товар с описанием и без', () => {
    expect(isPersonalized(parseSpec(gymnastics))).toBe(true);
    expect(isPersonalized(null)).toBe(false);
  });
});

describe('personalization/describe — человекочитаемый вид для админки и печати', () => {
  it('печатает подпись поля и значение, пропуская пустые', () => {
    const spec = parseSpec(gymnastics)!;
    const rows = describePersonalization(spec, {
      front: ['Иванова', 'Амелия', ''],
      apparatus: 'hoop',
    });
    expect(rows).toEqual([
      { label: 'Гравировка, лицевая сторона', value: 'Иванова / Амелия' },
      { label: 'Знак вида', value: 'Обруч' },
    ]);
  });

  it('для select печатает ПОДПИСЬ варианта, а не его код', () => {
    const spec = parseSpec(gymnastics)!;
    const rows = describePersonalization(spec, { front: ['Тест'], apparatus: 'ball' });
    expect(rows.find((r) => r.label === 'Знак вида')?.value).toBe('Мяч');
  });

  it('пустой выбор печатается подписью «ничего не выбрано», а не пустотой', () => {
    const spec = parseSpec(gymnastics)!;
    const rows = describePersonalization(spec, { front: ['Тест'], apparatus: '' });
    expect(rows.find((r) => r.label === 'Знак вида')?.value).toBe('Без знака');
  });

  it('поле, которого нет в значениях, не печатается вовсе', () => {
    const spec = parseSpec(gymnastics)!;
    const rows = describePersonalization(spec, { front: ['Тест'] });
    expect(rows.map((r) => r.label)).toEqual(['Гравировка, лицевая сторона']);
  });

  it('значение неизвестного варианта печатается как есть, а не теряется', () => {
    // Владелец мог убрать вариант из списка уже ПОСЛЕ заказа. В снимке заказа
    // код остался — потерять его нельзя, иначе цех не узнает, что наносить.
    const spec = parseSpec(gymnastics)!;
    const rows = describePersonalization(spec, { front: ['Тест'], apparatus: 'ribbon' });
    expect(rows.find((r) => r.label === 'Знак вида')?.value).toBe('ribbon');
  });
});
