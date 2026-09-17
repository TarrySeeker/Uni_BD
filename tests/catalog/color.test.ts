import { describe, expect, it } from 'vitest';

import {
  COLOR_ATTRIBUTE_CODE_PATTERNS,
  COLOR_ATTRIBUTE_NAMES,
  isColorAttribute,
  normalizeColorHex,
} from '@/lib/catalog/color';

// ЮНИТ: распознавание справочника «Цвет» и нормализация HEX (миграция 0043).
// Без БД: обе функции чистые. isColorAttribute — JS-зеркало SQL-условия
// репозитория, поэтому список признаков проверяем как единый источник правды.

describe('isColorAttribute', () => {
  it('узнаёт справочник по имени (регистр и пробелы не мешают)', () => {
    expect(isColorAttribute({ name: 'Цвет' })).toBe(true);
    expect(isColorAttribute({ name: '  ЦВЕТ  ' })).toBe(true);
    expect(isColorAttribute({ name: 'Color' })).toBe(true);
    expect(isColorAttribute({ name: 'colour' })).toBe(true);
  });

  it('узнаёт справочник по коду подстрокой (код задаёт контентщик магазина)', () => {
    expect(isColorAttribute({ code: 'color' })).toBe(true);
    expect(isColorAttribute({ code: 'demo-color' })).toBe(true);
    expect(isColorAttribute({ code: 'MAIN_COLOUR' })).toBe(true);
    expect(isColorAttribute({ code: 'tsvet' })).toBe(true);
    expect(isColorAttribute({ code: 'cvet_tovara' })).toBe(true);
  });

  it('прочие справочники цветом не считает (иначе в цветовой EAV попадут размеры)', () => {
    expect(isColorAttribute({ code: 'size', name: 'Размер' })).toBe(false);
    expect(isColorAttribute({ code: 'material', name: 'Материал' })).toBe(false);
    expect(isColorAttribute({})).toBe(false);
    expect(isColorAttribute({ code: '', name: '' })).toBe(false);
    expect(isColorAttribute({ code: null, name: null })).toBe(false);
  });

  it('каждый признак из общего списка распознаётся (список — зеркало SQL)', () => {
    for (const name of COLOR_ATTRIBUTE_NAMES) {
      expect(isColorAttribute({ name })).toBe(true);
    }
    for (const pattern of COLOR_ATTRIBUTE_CODE_PATTERNS) {
      // LIKE-шаблон без '%' — это та же подстрока, которую ищет JS-предикат.
      expect(isColorAttribute({ code: pattern.replaceAll('%', '') })).toBe(true);
    }
  });
});

describe('normalizeColorHex', () => {
  it('пропускает только валидный #RRGGBB (зеркало CHECK в БД)', () => {
    expect(normalizeColorHex('#FFFFFF')).toBe('#FFFFFF');
    expect(normalizeColorHex('#ff00aa')).toBe('#ff00aa');
    expect(normalizeColorHex('  #123ABC  ')).toBe('#123ABC');
  });

  it('всё остальное → null: мусор в inline-стиль свотча витрины не уходит', () => {
    expect(normalizeColorHex('FFFFFF')).toBeNull();
    expect(normalizeColorHex('#FFF')).toBeNull();
    expect(normalizeColorHex('#GGGGGG')).toBeNull();
    expect(normalizeColorHex('red')).toBeNull();
    expect(normalizeColorHex('')).toBeNull();
    expect(normalizeColorHex(null)).toBeNull();
    expect(normalizeColorHex(undefined)).toBeNull();
    expect(normalizeColorHex(0xffffff)).toBeNull();
  });

  it('не пропускает XSS-подобную полезную нагрузку в стиль', () => {
    expect(normalizeColorHex('#FFFFFF;background:url(javascript:alert(1))')).toBeNull();
    expect(normalizeColorHex('red;}</style><script>')).toBeNull();
  });
});
