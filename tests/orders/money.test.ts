import { describe, expect, it } from 'vitest';

import {
  fromMinor,
  normalizeMoney,
  percentOfMinor,
  toMinor,
} from '@/lib/orders/money';

/**
 * Точная денежная арифметика (lib/orders/money.ts) — копейки, без float-ошибок.
 * Юнит-тесты всегда зелёные (БД не нужна).
 */

describe('orders/money — toMinor (строка/число → копейки)', () => {
  it('парсит целое и дробное по тексту (без float)', () => {
    expect(toMinor('0')).toBe(0);
    expect(toMinor('10')).toBe(1000);
    expect(toMinor('19.99')).toBe(1999);
    expect(toMinor('19.9')).toBe(1990);
    expect(toMinor('0.01')).toBe(1);
    expect(toMinor('1234.56')).toBe(123456);
  });

  it('классическая float-ловушка 0.1 + 0.2 считается точно', () => {
    expect(toMinor('0.1') + toMinor('0.2')).toBe(toMinor('0.30'));
  });

  it('принимает number (через фиксированное представление)', () => {
    expect(toMinor(3000)).toBe(300000);
    expect(toMinor(19.99)).toBe(1999);
  });

  it('отклоняет некорректный формат и отрицательные', () => {
    expect(() => toMinor('1.999')).toThrow();
    expect(() => toMinor('-5')).toThrow();
    expect(() => toMinor('abc')).toThrow();
  });
});

describe('orders/money — fromMinor (копейки → строка NUMERIC(14,2))', () => {
  it('форматирует с ровно двумя знаками', () => {
    expect(fromMinor(0)).toBe('0.00');
    expect(fromMinor(1)).toBe('0.01');
    expect(fromMinor(1999)).toBe('19.99');
    expect(fromMinor(1990)).toBe('19.90');
    expect(fromMinor(123456)).toBe('1234.56');
  });

  it('отклоняет нецелые и отрицательные копейки', () => {
    expect(() => fromMinor(1.5)).toThrow();
    expect(() => fromMinor(-1)).toThrow();
  });

  it('round-trip toMinor∘fromMinor стабилен', () => {
    for (const s of ['0.00', '0.01', '99.99', '1000.00', '123456789.12']) {
      expect(fromMinor(toMinor(s))).toBe(s);
    }
  });
});

describe('orders/money — normalizeMoney', () => {
  it('приводит к каноничной форме с 2 знаками', () => {
    expect(normalizeMoney('5')).toBe('5.00');
    expect(normalizeMoney('5.5')).toBe('5.50');
    expect(normalizeMoney(3000)).toBe('3000.00');
  });
});

describe('orders/money — percentOfMinor (округление к копейке)', () => {
  it('round half-up к ближайшей копейке', () => {
    // 1999 коп × 10% = 199.9 коп → 200
    expect(percentOfMinor(1999, 10)).toBe(200);
    // 100 коп × 33% = 33 коп
    expect(percentOfMinor(100, 33)).toBe(33);
    // 333 коп × 33% = 109.89 → 110
    expect(percentOfMinor(333, 33)).toBe(110);
  });

  it('ноль/отрицательный процент → 0', () => {
    expect(percentOfMinor(1000, 0)).toBe(0);
    expect(percentOfMinor(1000, -5)).toBe(0);
  });
});
