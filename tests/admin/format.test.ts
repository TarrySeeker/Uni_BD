import { describe, it, expect } from 'vitest';

import {
  currencySymbol,
  formatPrice,
  formatDiscount,
} from '@/lib/admin/format';

/**
 * Юнит форматирования цены/скидки для UI каталога (docs/06 §3.5).
 * Чистые функции — без БД/Next. Валюта не хардкодится (карта символов).
 */

describe('currencySymbol', () => {
  it('возвращает символ для известных валют', () => {
    expect(currencySymbol('RUB')).toBe('₽');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
  });
  it('регистронезависим и обрезает пробелы', () => {
    expect(currencySymbol('rub')).toBe('₽');
    expect(currencySymbol('  RUB ')).toBe('₽');
  });
  it('незнакомый код возвращается как есть (фолбэк)', () => {
    expect(currencySymbol('XYZ')).toBe('XYZ');
  });
});

describe('formatPrice', () => {
  it('форматирует целую цену без дробной части', () => {
    //   — неразрывный пробел между суммой и символом.
    expect(formatPrice('199', 'RUB')).toBe('199 ₽');
    expect(formatPrice(199, 'RUB')).toBe('199 ₽');
  });
  it('форматирует .00 как целое', () => {
    expect(formatPrice('199.00', 'RUB')).toBe('199 ₽');
  });
  it('сохраняет 2 знака при дробной части', () => {
    expect(formatPrice('199.90', 'RUB')).toBe('199,90 ₽');
  });
  it('разделяет разряды (ru-RU узкий пробел)', () => {
    // toLocaleLocale ru-RU использует узкий неразрывный пробел ( ) как разрядный.
    const out = formatPrice('1999990', 'RUB');
    expect(out).toContain('₽');
    expect(out.replace(/[  \s]/g, '')).toBe('1999990₽');
  });
  it('по умолчанию валюта RUB', () => {
    expect(formatPrice('100')).toBe('100 ₽');
  });
  it('уважает иную валюту магазина (не хардкод ₽)', () => {
    expect(formatPrice('100', 'USD')).toBe('100 $');
    expect(formatPrice('100', 'KZT')).toBe('100 ₸');
  });
  it('невалидное/пустое → «—»', () => {
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(undefined)).toBe('—');
    expect(formatPrice('abc')).toBe('—');
  });
});

describe('formatDiscount', () => {
  it('форматирует процент с настоящим минусом', () => {
    expect(formatDiscount(21)).toBe('−21 %');
    expect(formatDiscount(5)).toBe('−5 %');
  });
  it('округляет дробный процент', () => {
    expect(formatDiscount(20.6)).toBe('−21 %');
  });
  it('null/0/отрицательное → null (бейдж скрыт)', () => {
    expect(formatDiscount(null)).toBeNull();
    expect(formatDiscount(undefined)).toBeNull();
    expect(formatDiscount(0)).toBeNull();
    expect(formatDiscount(-5)).toBeNull();
  });
});
