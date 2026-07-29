import { describe, it, expect } from 'vitest';

/**
 * ЭТАП 3 — показ РУЧНОЙ «круглой» цены в валюте отображения.
 *
 * formatDisplayPrice получает необязательную карту оверрайдов
 * ({"EUR":"480.00"}). Есть оверрайд для ВЫБРАННОЙ валюты → показываем ровно его;
 * нет → прежний пересчёт цена_₽ / rate. Импорт относительным путём: storefront —
 * отдельное Next-приложение со своим алиасом @.
 */

import {
  formatDisplayPrice,
  type DisplayCurrency,
} from '../../storefront/lib/format';

/**
 * Нормализуем ВСЕ виды пробелов-разделителей разрядов (NBSP U+00A0, узкий NBSP
 * U+202F — его использует ru-RU в новых ICU) к ASCII-пробелу, иначе сравнение
 * зависит от версии ICU в рантайме.
 */
const p = (s: string): string => s.replace(/[  ]/g, ' ');

const RUB: DisplayCurrency = { code: 'RUB', symbol: '₽', rate: 1, fractionDigits: 0 };
// Курс, при котором пересчёт даёт «некрасивое» число: 42605 / 88.76 = 480.0022…
const EUR: DisplayCurrency = { code: 'EUR', symbol: '€', rate: 88.76, fractionDigits: 2 };

describe('storefront/format — ручная цена (display_prices) имеет приоритет над курсом', () => {
  it('без карты оверрайдов поведение НЕ меняется (анти-регресс)', () => {
    expect(p(formatDisplayPrice('7500.00', RUB))).toBe('7 500 ₽');
    expect(p(formatDisplayPrice('7500.00', { ...EUR, rate: 100 }))).toBe('75,00 €');
    expect(p(formatDisplayPrice('7500.00', { ...EUR, rate: 100 }, undefined))).toBe('75,00 €');
    expect(p(formatDisplayPrice('7500.00', { ...EUR, rate: 100 }, {}))).toBe('75,00 €');
  });

  it('🔴 оверрайд показывается ровно как задан: 480 €, а не 4783,12 €', () => {
    // Курсовой пересчёт 42605 ₽ / 88.76 дал бы 480,00 €, но владелец хочет «480 €»
    // при ЛЮБОМ курсе — проверяем на курсе, где пересчёт заведомо некрасив.
    const ugly = { ...EUR, rate: 8.9 }; // 42605 / 8.9 = 4787,07 €
    expect(p(formatDisplayPrice('42605.00', ugly))).toBe('4 787,08 €');
    expect(p(formatDisplayPrice('42605.00', ugly, { EUR: '480.00' }))).toBe('480,00 €');
  });

  it('оверрайд ищется по КОДУ выбранной валюты; чужие коды игнорируются', () => {
    const usd = { code: 'USD', symbol: '$', rate: 90, fractionDigits: 2 };
    // Карта содержит только EUR → для USD считаем по курсу.
    expect(p(formatDisplayPrice('9000.00', usd, { EUR: '480.00' }))).toBe('100,00 $');
    // А для EUR — берём оверрайд.
    expect(p(formatDisplayPrice('9000.00', EUR, { EUR: '480.00' }))).toBe('480,00 €');
  });

  it('регистр кода валюты в карте не важен', () => {
    expect(p(formatDisplayPrice('9000.00', EUR, { eur: '480.00' }))).toBe('480,00 €');
  });

  it('оверрайд форматируется локалью/знаками магазина, а не печатается сырьём', () => {
    expect(p(formatDisplayPrice('9000.00', EUR, { EUR: '1480.5' }))).toBe('1 480,50 €');
    const en = { ...EUR, locale: 'en-US' };
    expect(p(formatDisplayPrice('9000.00', en, { EUR: '1480.5' }))).toBe('1,480.50 €');
  });

  it('мусорный/неположительный оверрайд игнорируется → возврат к курсу', () => {
    const byRate = p(formatDisplayPrice('9000.00', { ...EUR, rate: 100 }));
    expect(byRate).toBe('90,00 €');
    for (const bad of ['', '   ', 'abc', '0', '-480'] as const) {
      expect(p(formatDisplayPrice('9000.00', { ...EUR, rate: 100 }, { EUR: bad }))).toBe(byRate);
    }
  });

  it('оверрайд для БАЗОВОЙ валюты не ломает рублёвый показ', () => {
    // Базовая валюта — деньги, а не «отображение»; оверрайд к ней применяться не
    // должен: иначе цена товара разошлась бы с суммой заказа.
    expect(p(formatDisplayPrice('7500.00', RUB, { RUB: '9999.00' }))).toBe('7 500 ₽');
  });

  it('пустая цена → пустая строка даже при наличии оверрайда', () => {
    expect(formatDisplayPrice(null, EUR, { EUR: '480.00' })).toBe('');
    expect(formatDisplayPrice(undefined, EUR, { EUR: '480.00' })).toBe('');
  });
});
