import { describe, expect, it } from 'vitest';

import { combineDiscountsMinor, type CombinableDiscount } from '@/lib/orders/pricing';

/**
 * Комбинируемость/приоритет промо-скидок (docs/11 §5.2, Пакет 5.P-1) — ЧИСТАЯ.
 *
 * MVP-правило: ≤1 не-stackable (выбор по priority asc, tie-break code asc) + все
 * stackable; суммарный discount жёстко clamp в [0, itemsMinor]. Детерминирован.
 */

function d(over: Partial<CombinableDiscount> = {}): CombinableDiscount {
  return {
    code: over.code ?? 'X',
    priority: over.priority ?? 100,
    stackable: over.stackable ?? false,
    discountMinor: over.discountMinor ?? 0,
  };
}

describe('combineDiscountsMinor', () => {
  it('две stackable суммируются', () => {
    const res = combineDiscountsMinor(
      [
        d({ code: 'A', stackable: true, discountMinor: 10000 }),
        d({ code: 'B', stackable: true, discountMinor: 20000 }),
      ],
      100000,
    );
    expect(res.totalMinor).toBe(30000);
    expect(res.appliedCodes.sort()).toEqual(['A', 'B']);
  });

  it('две не-stackable → выбирается одна по priority asc', () => {
    const res = combineDiscountsMinor(
      [
        d({ code: 'A', priority: 50, stackable: false, discountMinor: 10000 }),
        d({ code: 'B', priority: 100, stackable: false, discountMinor: 20000 }),
      ],
      100000,
    );
    expect(res.totalMinor).toBe(10000);
    expect(res.appliedCodes).toEqual(['A']);
  });

  it('не-stackable с равным priority → tie-break по code asc', () => {
    const res = combineDiscountsMinor(
      [
        d({ code: 'ZED', priority: 100, stackable: false, discountMinor: 30000 }),
        d({ code: 'ALPHA', priority: 100, stackable: false, discountMinor: 10000 }),
      ],
      100000,
    );
    expect(res.appliedCodes).toEqual(['ALPHA']);
    expect(res.totalMinor).toBe(10000);
  });

  it('одна не-stackable + все stackable суммируются', () => {
    const res = combineDiscountsMinor(
      [
        d({ code: 'EXCL', priority: 10, stackable: false, discountMinor: 5000 }),
        d({ code: 'OTHEREXCL', priority: 20, stackable: false, discountMinor: 9999 }),
        d({ code: 'S1', stackable: true, discountMinor: 3000 }),
        d({ code: 'S2', stackable: true, discountMinor: 2000 }),
      ],
      100000,
    );
    // выбран EXCL (priority 10) + S1 + S2 = 10000; OTHEREXCL отброшен
    expect(res.totalMinor).toBe(10000);
    expect(res.appliedCodes.sort()).toEqual(['EXCL', 'S1', 'S2']);
  });

  it('суммарная скидка clamp ≤ itemsMinor', () => {
    const res = combineDiscountsMinor(
      [
        d({ code: 'A', stackable: true, discountMinor: 40000 }),
        d({ code: 'B', stackable: true, discountMinor: 40000 }),
      ],
      30000,
    );
    expect(res.totalMinor).toBe(30000);
  });

  it('clamp ≥ 0; пустой вход → 0', () => {
    expect(combineDiscountsMinor([], 100000)).toEqual({ totalMinor: 0, appliedCodes: [] });
  });

  it('детерминирован: порядок входа не влияет на итог', () => {
    const input = [
      d({ code: 'B', stackable: true, discountMinor: 20000 }),
      d({ code: 'A', stackable: true, discountMinor: 10000 }),
    ];
    const a = combineDiscountsMinor(input, 100000);
    const b = combineDiscountsMinor([...input].reverse(), 100000);
    expect(a.totalMinor).toBe(b.totalMinor);
    expect(a.appliedCodes.sort()).toEqual(b.appliedCodes.sort());
  });
});
