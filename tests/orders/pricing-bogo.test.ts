import { describe, expect, it } from 'vitest';

import { bogoDiscountMinor, type PricedLine } from '@/lib/orders/pricing';

/**
 * Матрица BOGO «N по M» (docs/11 §5.2, Пакет 5.P-1) — ЧИСТАЯ функция, без БД.
 *
 * Алгоритм (детерминированный): floor(totalQty / buyQty) групп; в каждой
 * бесплатны (buyQty − payQty) единиц; бесплатны САМЫЕ ДЕШЁВЫЕ единицы во всём
 * наборе линий (в пределах scope). Деньги — целые копейки, без float.
 */

function line(over: Partial<PricedLine> = {}): PricedLine {
  return {
    name: over.name ?? 'Товар',
    sku: over.sku ?? 'SKU-1',
    unitPrice: over.unitPrice ?? '100.00',
    compareAt: over.compareAt ?? null,
    qty: over.qty ?? 1,
  };
}

describe('bogoDiscountMinor — «N по M»', () => {
  it('«3 по 2», 3×100 → бесплатна 1 → 100.00 (10000 коп.)', () => {
    expect(bogoDiscountMinor([line({ unitPrice: '100.00', qty: 3 })], 3, 2)).toBe(10000);
  });

  it('«3 по 2», 6 шт → 2 бесплатно → 200.00', () => {
    expect(bogoDiscountMinor([line({ unitPrice: '100.00', qty: 6 })], 3, 2)).toBe(20000);
  });

  it('«3 по 2», 5 шт → 1 бесплатно (floor(5/3)=1)', () => {
    expect(bogoDiscountMinor([line({ unitPrice: '100.00', qty: 5 })], 3, 2)).toBe(10000);
  });

  it('«3 по 2», разные цены [100,200,300] → бесплатна самая дешёвая (100)', () => {
    const lines = [
      line({ sku: 'A', unitPrice: '300.00', qty: 1 }),
      line({ sku: 'B', unitPrice: '100.00', qty: 1 }),
      line({ sku: 'C', unitPrice: '200.00', qty: 1 }),
    ];
    expect(bogoDiscountMinor(lines, 3, 2)).toBe(10000);
  });

  it('«3 по 2», 6 разных единиц [300×3, 100×3] → бесплатны 2 самые дешёвые (100+100)', () => {
    const lines = [
      line({ sku: 'EXP', unitPrice: '300.00', qty: 3 }),
      line({ sku: 'CHEAP', unitPrice: '100.00', qty: 3 }),
    ];
    // totalQty=6 → 2 группы → 2 бесплатно → 2 самые дешёвые = 100+100
    expect(bogoDiscountMinor(lines, 3, 2)).toBe(20000);
  });

  it('«купи 2 плати 1», 4 шт → 2 бесплатно', () => {
    expect(bogoDiscountMinor([line({ unitPrice: '50.00', qty: 4 })], 2, 1)).toBe(10000);
  });

  it('qty < buyQty → нет групп → 0', () => {
    expect(bogoDiscountMinor([line({ unitPrice: '100.00', qty: 2 })], 3, 2)).toBe(0);
  });

  it('пустой набор линий → 0', () => {
    expect(bogoDiscountMinor([], 3, 2)).toBe(0);
  });

  it('копейки без float: 33.33 ×3 «3 по 2» → 33.33 (3333 коп.)', () => {
    expect(bogoDiscountMinor([line({ unitPrice: '33.33', qty: 3 })], 3, 2)).toBe(3333);
  });

  it('некорректная пара (payQty ≥ buyQty) → 0 (защита, схема не должна такое пропускать)', () => {
    expect(bogoDiscountMinor([line({ qty: 6 })], 2, 3)).toBe(0);
    expect(bogoDiscountMinor([line({ qty: 6 })], 2, 2)).toBe(0);
  });

  it('скидка ≤ суммы набора (никогда не уводит итог в минус)', () => {
    const lines = [line({ unitPrice: '100.00', qty: 9 })];
    const discount = bogoDiscountMinor(lines, 3, 2);
    const itemsMinor = 9 * 10000;
    expect(discount).toBeLessThanOrEqual(itemsMinor);
    // 9 шт → 3 группы → 3 бесплатно → 300.00
    expect(discount).toBe(30000);
  });
});
