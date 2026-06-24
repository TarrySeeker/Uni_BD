import { describe, expect, it } from 'vitest';

import {
  emptyScopeTargets,
  scopeDiscountMinor,
  scopedQty,
  type PricedLine,
  type PromoScopeTargets,
} from '@/lib/orders/pricing';

/**
 * Скидка percent/fixed по ПОДМНОЖЕСТВУ линий scope (docs/11 §5.2, Пакет 5.P-1).
 *
 * ЧИСТАЯ функция: принимает уже отфильтрованные сервером линии target (anti-tamper:
 * принадлежность scope определяет каталог, не тело запроса). Вне scope — не наш
 * вход. Деньги — целые копейки.
 */

function line(over: Partial<PricedLine> = {}): PricedLine {
  return {
    name: over.name ?? 'Товар',
    sku: over.sku ?? 'SKU-1',
    unitPrice: over.unitPrice ?? '100.00',
    compareAt: over.compareAt ?? null,
    qty: over.qty ?? 1,
    productId: over.productId,
    variantId: over.variantId,
    categoryIds: over.categoryIds,
    brandId: over.brandId,
  };
}

describe('scopeDiscountMinor — percent по scope', () => {
  it('percent 10% к подмножеству [100×1, 200×1] → 30.00', () => {
    const lines = [line({ unitPrice: '100.00' }), line({ unitPrice: '200.00' })];
    expect(scopeDiscountMinor(lines, { kind: 'percent', value: '10' })).toBe(3000);
  });

  it('percent с потолком maxDiscount обрезается', () => {
    const lines = [line({ unitPrice: '1000.00', qty: 1 })];
    expect(
      scopeDiscountMinor(lines, { kind: 'percent', value: '50', maxDiscount: '100.00' }),
    ).toBe(10000); // 50% от 1000 = 500, но потолок 100
  });

  it('пустое пересечение (нет линий в scope) → 0', () => {
    expect(scopeDiscountMinor([], { kind: 'percent', value: '20' })).toBe(0);
  });

  it('минимальное количество minQty не достигнуто → 0', () => {
    const lines = [line({ unitPrice: '100.00', qty: 2 })];
    expect(
      scopeDiscountMinor(lines, { kind: 'percent', value: '10', minQty: 3 }),
    ).toBe(0);
  });

  it('минимальное количество minQty достигнуто → скидка применяется', () => {
    const lines = [line({ unitPrice: '100.00', qty: 3 })];
    expect(
      scopeDiscountMinor(lines, { kind: 'percent', value: '10', minQty: 3 }),
    ).toBe(3000); // 10% от 300
  });
});

describe('scopedQty — кол-во единиц в scope (баг A волны 7)', () => {
  function targetsWithCategory(categoryId: string): PromoScopeTargets {
    const t = emptyScopeTargets();
    t.categoryIds.add(categoryId);
    return t;
  }

  it('scope=cart → сумма qty ВСЕХ линий (как раньше)', () => {
    const lines = [
      line({ qty: 2, categoryIds: ['c1'] }),
      line({ qty: 5 }),
    ];
    expect(scopedQty(lines, 'cart', emptyScopeTargets())).toBe(7);
  });

  it('scope=category → только qty линий в категории-таргете (а не всей корзины)', () => {
    const lines = [
      line({ qty: 2, categoryIds: ['c1'] }), // в scope
      line({ qty: 5, categoryIds: ['c2'] }), // вне scope
    ];
    // Корзина 7 единиц, но в scope только 2 → minQty=3 НЕ достигнут (баг A).
    expect(scopedQty(lines, 'category', targetsWithCategory('c1'))).toBe(2);
  });

  it('scope=category без совпадений → 0', () => {
    const lines = [line({ qty: 3, categoryIds: ['c9'] })];
    expect(scopedQty(lines, 'category', targetsWithCategory('c1'))).toBe(0);
  });
});

describe('scopeDiscountMinor — fixed по scope', () => {
  it('fixed = min(value, сумма scope)', () => {
    const lines = [line({ unitPrice: '100.00', qty: 1 })];
    expect(scopeDiscountMinor(lines, { kind: 'fixed', value: '300.00' })).toBe(10000);
    expect(scopeDiscountMinor(lines, { kind: 'fixed', value: '40.00' })).toBe(4000);
  });

  it('скидка ≤ суммы scope и ≥ 0', () => {
    const lines = [line({ unitPrice: '50.00', qty: 4 })]; // 200
    const d = scopeDiscountMinor(lines, { kind: 'percent', value: '200' });
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(20000);
  });
});
