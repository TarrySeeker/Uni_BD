import { describe, it, expect } from 'vitest';

import {
  assertRedeemable,
  computeApplicableAmount,
  resolveGiftApplication,
} from '@/lib/gift-certificates/service';
import { GiftCertificateError } from '@/lib/gift-certificates/errors';
import type { GiftCertificate } from '@/lib/gift-certificates/types';

function cert(over: Partial<GiftCertificate> = {}): GiftCertificate {
  return {
    id: 'g1',
    code: 'GIFT500',
    name: 'Test',
    description: null,
    terms: null,
    initialAmount: '500.00',
    spentTotal: '0.00',
    remaining: '500.00',
    currency: 'RUB',
    status: 'active',
    validUntil: null,
    translations: {},
    comment: '',
    purchaser: { name: null, email: null, phone: null },
    purchaserCustomerId: null,
    recipient: { name: null, email: null, phone: null },
    issuedOrderId: null,
    issuedOrderItemId: null,
    issueSource: 'manual',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('gift-certificates/service — assertRedeemable', () => {
  it('active + остаток → возвращает остаток', () => {
    expect(assertRedeemable(cert({ spentTotal: '100.00' }))).toBe('400.00');
  });

  it('disabled → GiftCertificateError(disabled)', () => {
    expect(() => assertRedeemable(cert({ status: 'disabled' }))).toThrow(GiftCertificateError);
  });

  it('depleted → бросает', () => {
    expect(() => assertRedeemable(cert({ status: 'depleted', spentTotal: '500.00' }))).toThrow(
      GiftCertificateError,
    );
  });

  it('истёкший срок → бросает (expired)', () => {
    expect(() =>
      assertRedeemable(cert({ validUntil: new Date('2020-01-01') }), new Date('2026-01-01')),
    ).toThrow(/срок/i);
  });

  it('активный, но остаток 0 → бросает', () => {
    expect(() => assertRedeemable(cert({ spentTotal: '500.00' }))).toThrow(GiftCertificateError);
  });
});

describe('gift-certificates/service — computeApplicableAmount / resolveGiftApplication', () => {
  it('applied = min(остаток, к оплате)', () => {
    expect(computeApplicableAmount(cert({ spentTotal: '300.00' }), '120.00')).toBe('120.00');
    expect(computeApplicableAmount(cert({ spentTotal: '300.00' }), '500.00')).toBe('200.00');
  });

  it('resolveGiftApplication считает applied и остаток после (не мутирует)', () => {
    const app = resolveGiftApplication(cert({ spentTotal: '300.00' }), '120.00');
    expect(app.remaining).toBe('200.00');
    expect(app.appliedAmount).toBe('120.00');
    expect(app.balanceRemainingAfter).toBe('80.00');
  });

  it('resolveGiftApplication: корзина больше остатка → списывает весь остаток, после = 0', () => {
    const app = resolveGiftApplication(cert({ spentTotal: '300.00' }), '999.00');
    expect(app.appliedAmount).toBe('200.00');
    expect(app.balanceRemainingAfter).toBe('0.00');
  });
});
