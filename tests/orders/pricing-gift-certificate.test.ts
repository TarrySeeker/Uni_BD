import { describe, expect, it } from 'vitest';

import {
  applyGiftCertificate,
  calculateQuote,
  type PricedLine,
} from '@/lib/orders/pricing';
import { toQuoteDto } from '@/lib/storefront/order-dto';
import { toGiftQuoteDto } from '@/lib/storefront/gift-dto';
import type { GiftQuoteInfo } from '@/lib/orders/repository';

/**
 * ЮНИТ (без БД) — чистое ядро применения подарочного сертификата к итогу корзины
 * (docs/24 §5, §11). Проверяет ASSUMED-порядок стекования promo→gift, что gift
 * применяется к нетто-товарам ПОСЛЕ промо и НЕ покрывает доставку, клампы, и
 * что DTO уменьшает сумму к оплате и скрывает номинал/потраченное.
 */

function line(unitPrice: string, qty = 1): PricedLine {
  return { name: 'T', sku: 'SKU', unitPrice, compareAt: null, qty };
}

function quote(opts: {
  items: PricedLine[];
  promo?: Parameters<typeof calculateQuote>[0]['promo'];
  deliveryCost?: string;
}) {
  return calculateQuote({
    lines: opts.items,
    promo: opts.promo ?? null,
    delivery: { cost: opts.deliveryCost ?? '0.00', freeThreshold: 0 },
  });
}

describe('applyGiftCertificate — чистое ядро (§5, §11)', () => {
  it('частичное покрытие: остаток 200, товары 300 → списано 200, к оплате 100', () => {
    const q = quote({ items: [line('300.00')] });
    const g = applyGiftCertificate(q, '200.00');
    expect(g.giftDiscount).toBe('200.00');
    expect(g.grandTotal).toBe('100.00');
    expect(g.amountDue).toBe('300.00');
  });

  it('клампится по нетто-товарам: остаток 500, товары 100 → списано 100, к оплате 0', () => {
    const q = quote({ items: [line('100.00')] });
    const g = applyGiftCertificate(q, '500.00');
    expect(g.giftDiscount).toBe('100.00');
    expect(g.grandTotal).toBe('0.00');
  });

  it('ДОСТАВКУ сертификат НЕ покрывает: товары 100 + доставка 50, остаток 500 → списано 100, к оплате 50', () => {
    const q = quote({ items: [line('100.00')], deliveryCost: '50.00' });
    expect(q.grandTotal).toBe('150.00');
    const g = applyGiftCertificate(q, '500.00');
    expect(g.giftDiscount).toBe('100.00'); // только нетто-товары
    expect(g.grandTotal).toBe('50.00'); // осталась доставка
  });

  it('СТЕКОВАНИЕ promo→gift: 10% promo сначала, gift к остатку', () => {
    const q = quote({
      items: [line('1000.00')],
      promo: {
        code: 'P10',
        kind: 'percent',
        value: '10',
        maxDiscount: null,
        bogoBuyQty: null,
        bogoPayQty: null,
      },
    });
    expect(q.discount).toBe('100.00'); // 10% промо
    const g = applyGiftCertificate(q, '500.00');
    // amountDue = 1000 − 100 = 900; gift = min(500, 900) = 500; к оплате 900 − 500 = 400.
    expect(g.amountDue).toBe('900.00');
    expect(g.giftDiscount).toBe('500.00');
    expect(g.grandTotal).toBe('400.00');
  });

  it('нетто 0 (промо покрыл всё): сертификат не списывается', () => {
    const q = quote({
      items: [line('100.00')],
      promo: {
        code: 'FIX',
        kind: 'fixed',
        value: '100',
        maxDiscount: null,
        bogoBuyQty: null,
        bogoPayQty: null,
      },
    });
    expect(q.discount).toBe('100.00');
    const g = applyGiftCertificate(q, '500.00');
    expect(g.giftDiscount).toBe('0.00');
    expect(g.grandTotal).toBe(q.grandTotal);
  });

  it('remaining=null → сертификат не применяется', () => {
    const q = quote({ items: [line('300.00')] });
    const g = applyGiftCertificate(q, null);
    expect(g.giftDiscount).toBe('0.00');
    expect(g.grandTotal).toBe('300.00');
  });
});

describe('toGiftQuoteDto / toQuoteDto — витрина (§5)', () => {
  const giftInfo: GiftQuoteInfo = {
    applied: true,
    code: 'GC500',
    appliedAmount: '200.00',
    balanceRemainingAfter: '300.00',
    reason: null,
  };

  it('toGiftQuoteDto отдаёт applied/appliedAmount/остаток и НЕ раскрывает номинал/потрачено', () => {
    const dto = toGiftQuoteDto(giftInfo)!;
    expect(dto.appliedAmount).toBe('200.00');
    expect(dto.balanceRemainingAfter).toBe('300.00');
    expect(dto).not.toHaveProperty('faceValue');
    expect(dto).not.toHaveProperty('initialAmount');
    expect(dto).not.toHaveProperty('spentTotal');
  });

  it('toGiftQuoteDto(null) → null (код не передан)', () => {
    expect(toGiftQuoteDto(null)).toBeNull();
  });

  it('toQuoteDto: grandTotal уменьшается на списание, giftDiscountTotal и блок gift присутствуют', () => {
    const q = quote({ items: [line('300.00')] }); // grandTotal 300
    const dto = toQuoteDto({
      quote: q,
      currency: 'RUB',
      fulfillable: true,
      gift: giftInfo,
      issues: [],
    });
    expect(dto.giftDiscountTotal).toBe('200.00');
    expect(dto.grandTotal).toBe('100.00'); // 300 − 200
    expect(dto.gift?.applied).toBe(true);
    expect(dto.gift?.appliedAmount).toBe('200.00');
  });

  it('toQuoteDto: невалидный сертификат (applied=false) не меняет grandTotal, reason проброшен', () => {
    const q = quote({ items: [line('300.00')] });
    const dto = toQuoteDto({
      quote: q,
      currency: 'RUB',
      fulfillable: true,
      gift: { applied: false, code: 'BAD', appliedAmount: '0.00', balanceRemainingAfter: '0.00', reason: 'expired' },
      issues: [],
    });
    expect(dto.giftDiscountTotal).toBe('0.00');
    expect(dto.grandTotal).toBe('300.00');
    // 🔴 АУДИТ (безопасность): причина СКЛЕЕНА — 'expired' подтверждало бы, что
    // сертификат с таким кодом СУЩЕСТВУЕТ (деньги на предъявителя, угадывание
    // кодов). Проверяем, что reason не потерян (витрине есть что перевести), но
    // существование кода не раскрыто. См. tests/storefront/code-privacy.test.ts.
    expect(dto.gift?.reason).toBe('not_applicable');
  });

  it('toQuoteDto без сертификата: gift=null, grandTotal без изменений', () => {
    const q = quote({ items: [line('300.00')] });
    const dto = toQuoteDto({ quote: q, currency: 'RUB', fulfillable: true, issues: [] });
    expect(dto.gift).toBeNull();
    expect(dto.giftDiscountTotal).toBe('0.00');
    expect(dto.grandTotal).toBe('300.00');
  });
});
