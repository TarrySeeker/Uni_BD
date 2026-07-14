import { describe, it, expect } from 'vitest';

import {
  remainingMinor,
  computeRemaining,
  computeApplicableMinor,
  computeApplicable,
  isRedeemable,
  certRemaining,
} from '@/lib/gift-certificates/balance';

/**
 * ЮНИТ — чистое балансовое ядро (docs/24 §5). Семантика Cart::promoCodeSumValue:
 * applied = min(остаток, сумма к оплате); остаток = номинал − потрачено.
 */
describe('gift-certificates/balance — остаток и применяемая сумма', () => {
  it('remaining = initial − spent (копейки)', () => {
    expect(remainingMinor(50000, 30000)).toBe(20000);
    expect(computeRemaining('500.00', '300.00')).toBe('200.00');
    expect(computeRemaining('500.00', '0.00')).toBe('500.00');
  });

  it('остаток клампится в [0, ∞) при грязных входах', () => {
    expect(remainingMinor(10000, 15000)).toBe(0);
  });

  it('applied = min(остаток, сумма к оплате) — частичное списание', () => {
    // остаток 200, корзина 120 → списывается 120 (частично)
    expect(computeApplicable('200.00', '120.00')).toBe('120.00');
    // остаток 200, корзина 500 → списывается только 200 (весь остаток)
    expect(computeApplicable('200.00', '500.00')).toBe('200.00');
    // точное равенство
    expect(computeApplicable('200.00', '200.00')).toBe('200.00');
  });

  it('applied в копейках: ноль/битые входы → 0', () => {
    expect(computeApplicableMinor(0, 5000)).toBe(0);
    expect(computeApplicableMinor(5000, 0)).toBe(0);
    expect(computeApplicableMinor(-100, 5000)).toBe(0);
    expect(computeApplicableMinor(Number.NaN, 5000)).toBe(0);
    expect(computeApplicableMinor(5000, Number.NaN)).toBe(0);
  });

  it('дробные копейки: 199.99 остаток, 250 корзина → 199.99', () => {
    expect(computeApplicable('199.99', '250.00')).toBe('199.99');
  });

  it('certRemaining вычисляет остаток из полей сертификата', () => {
    expect(certRemaining({ initialAmount: '1000.00', spentTotal: '250.50' })).toBe('749.50');
  });
});

describe('gift-certificates/balance — isRedeemable', () => {
  const base = {
    status: 'active' as const,
    initialAmount: '500.00',
    spentTotal: '0.00',
    validUntil: null as Date | null,
  };

  it('active + остаток > 0 + без срока → применим', () => {
    expect(isRedeemable(base)).toBe(true);
  });

  it('исчерпанный остаток → не применим (даже если status active)', () => {
    expect(isRedeemable({ ...base, spentTotal: '500.00' })).toBe(false);
  });

  it('status disabled/depleted/expired → не применим', () => {
    expect(isRedeemable({ ...base, status: 'disabled' })).toBe(false);
    expect(isRedeemable({ ...base, status: 'depleted' })).toBe(false);
    expect(isRedeemable({ ...base, status: 'expired' })).toBe(false);
  });

  it('истёкший срок → не применим, даже если status active (страховка на не обновлённый крон)', () => {
    const past = new Date('2020-01-01T00:00:00Z');
    expect(isRedeemable({ ...base, validUntil: past }, new Date('2026-01-01T00:00:00Z'))).toBe(false);
  });

  it('будущий срок → применим', () => {
    const future = new Date('2030-01-01T00:00:00Z');
    expect(isRedeemable({ ...base, validUntil: future }, new Date('2026-01-01T00:00:00Z'))).toBe(true);
  });
});
