import { describe, it, expect } from 'vitest';

/**
 * Тесты витринного форматтера мультивалюты (storefront/lib/format.ts).
 * Импорт относительным путём: storefront — отдельное Next-приложение со своим
 * алиасом @, поэтому из корневого vitest тянем модуль напрямую по пути (он
 * standalone, без @/-импортов).
 *
 * Проверяем: пересчёт цена_₽ / rate, округление ₽ (0 знаков) vs € (2 знака),
 * защиту от rate<=0, анти-регресс рублёвого показа (legacy formatPrice).
 */

import {
  formatDisplayPrice,
  formatPrice,
  type DisplayCurrency,
} from '../../storefront/lib/format';

/**
 * Intl.NumberFormat('ru-RU') разделяет разряды НЕРАЗРЫВНЫМ пробелом (U+00A0), а не
 * ASCII-пробелом. Нормализуем оба к ASCII перед сравнением, чтобы тест не зависел
 * от типа пробела (иначе ожидание с ASCII-пробелом не равно выводу с NBSP).
 */
const p = (s: string): string => s.replace(/ /g, ' ');

const RUB: DisplayCurrency = { code: 'RUB', symbol: '₽', rate: 1, fractionDigits: 0 };
const EUR: DisplayCurrency = { code: 'EUR', symbol: '€', rate: 100, fractionDigits: 2 };

describe('storefront/format — formatDisplayPrice (мультивалюта)', () => {
  it('базовая ₽ (rate=1): округляет до целого, символ ₽', () => {
    expect(p(formatDisplayPrice('7500.00', RUB))).toBe('7 500 ₽');
    expect(p(formatDisplayPrice(7500, RUB))).toBe('7 500 ₽');
  });

  it('€ по курсу: цена_₽ / rate, 2 знака, символ €', () => {
    // 7500 ₽ / 100 = 75.00 €
    expect(p(formatDisplayPrice('7500.00', EUR))).toBe('75,00 €');
    // 7550 ₽ / 100 = 75.50 €
    expect(p(formatDisplayPrice(7550, EUR))).toBe('75,50 €');
  });

  it('€ с дробным курсом: 7500 / 90.5', () => {
    const eur = { ...EUR, rate: 90.5 };
    // 7500 / 90.5 = 82.87... → 82,87 €
    expect(p(formatDisplayPrice(7500, eur))).toBe('82,87 €');
  });

  it('rate<=0 защищён: трактуем как базовую (не делим на ноль), целое + символ валюты', () => {
    expect(p(formatDisplayPrice(7500, { ...EUR, rate: 0 }))).toBe('7 500 €');
    expect(p(formatDisplayPrice(7500, { ...EUR, rate: -5 }))).toBe('7 500 €');
  });

  it('пустое/некорректное значение → пустая строка', () => {
    expect(formatDisplayPrice(null, EUR)).toBe('');
    expect(formatDisplayPrice(undefined, RUB)).toBe('');
    expect(formatDisplayPrice('abc', EUR)).toBe('');
  });
});

describe('storefront/format — formatPrice (анти-регресс рублёвого показа)', () => {
  it('дефолт без валюты → рубли как раньше', () => {
    expect(p(formatPrice('7500.00'))).toBe('7 500 ₽');
  });
  it('явный код EUR → символ €, округление до целого (legacy-поведение)', () => {
    expect(p(formatPrice('75', 'EUR'))).toBe('75 €');
  });
});
