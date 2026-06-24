import { describe, expect, it } from 'vitest';

import {
  discountPercent,
  isOnSale,
  effectiveCompareAt,
  resolveIsNew,
} from '@/lib/catalog/pricing';

// ЮНИТ: чистое ценообразование (docs/06 §3.1–§3.2) — всегда зелёное, без БД.

describe('discountPercent', () => {
  it('считает процент при compareAt > price (round)', () => {
    expect(discountPercent('100', '127')).toBe(21); // (127-100)/127 = 21.26 → 21
    expect(discountPercent('80', '100')).toBe(20);
    expect(discountPercent(75, 100)).toBe(25);
  });
  it('null, если скидки нет (compareAt <= price)', () => {
    expect(discountPercent('100', '100')).toBeNull();
    expect(discountPercent('100', '90')).toBeNull();
  });
  it('null при отсутствии/некорректности compareAt или price', () => {
    expect(discountPercent('100', null)).toBeNull();
    expect(discountPercent('100', undefined)).toBeNull();
    expect(discountPercent(null, '100')).toBeNull();
    expect(discountPercent('100', '0')).toBeNull();
    expect(discountPercent('abc', '100')).toBeNull();
  });
  it('принимает строки и числа', () => {
    expect(discountPercent('199.90', '249.90')).toBe(20); // 50/249.9 = 20.0 → 20
  });
});

describe('isOnSale', () => {
  it('true только когда compareAt строго больше price', () => {
    expect(isOnSale('100', '120')).toBe(true);
    expect(isOnSale('100', '100')).toBe(false);
    expect(isOnSale('100', '90')).toBe(false);
  });
  it('false без compareAt или при нечисловом', () => {
    expect(isOnSale('100', null)).toBe(false);
    expect(isOnSale('100', undefined)).toBe(false);
    expect(isOnSale(null, '120')).toBe(false);
    expect(isOnSale('abc', '120')).toBe(false);
  });
});

describe('effectiveCompareAt', () => {
  it('берёт значение варианта, если задано', () => {
    expect(effectiveCompareAt('90', '100')).toBe(90);
    expect(effectiveCompareAt('0', '100')).toBe(0); // 0 — валидное значение, не наследует
  });
  it('наследует от товара, если у варианта нет', () => {
    expect(effectiveCompareAt(null, '100')).toBe(100);
    expect(effectiveCompareAt(undefined, '100')).toBe(100);
  });
  it('null, если нет ни там ни там', () => {
    expect(effectiveCompareAt(null, null)).toBeNull();
  });
});

describe('resolveIsNew — троичная логика', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('явный override true/false возвращается как есть (дата игнорируется)', () => {
    const old = new Date('2020-01-01T00:00:00Z');
    expect(resolveIsNew(true, old, 30, now)).toBe(true);
    const fresh = new Date('2026-06-14T00:00:00Z');
    expect(resolveIsNew(false, fresh, 30, now)).toBe(false);
  });

  it('null → вычисление по дате в пределах newDays', () => {
    const within = new Date('2026-06-01T00:00:00Z'); // 14 дней назад
    expect(resolveIsNew(null, within, 30, now)).toBe(true);
    const outside = new Date('2026-04-01T00:00:00Z'); // >30 дней назад
    expect(resolveIsNew(null, outside, 30, now)).toBe(false);
  });

  it('граница newDays включительно', () => {
    const exactly = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(resolveIsNew(null, exactly, 30, now)).toBe(true);
    const justPast = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000 - 1);
    expect(resolveIsNew(null, justPast, 30, now)).toBe(false);
  });

  it('newDays = 0 → ничего не «новое» (кроме ровно сейчас)', () => {
    const old = new Date('2026-06-14T00:00:00Z');
    expect(resolveIsNew(null, old, 0, now)).toBe(false);
  });

  it('некорректная дата → false при вычислении', () => {
    expect(resolveIsNew(null, new Date('invalid'), 30, now)).toBe(false);
  });
});
