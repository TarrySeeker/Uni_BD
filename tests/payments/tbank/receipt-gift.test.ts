import { describe, it, expect } from 'vitest';
import { buildReceipt, receiptTotalKop, toKopecks } from '@/lib/payments/tbank/receipt';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import type { Order, OrderItem } from '@/lib/orders/types';

/**
 * Аудит major #14: чек 54-ФЗ не учитывал списание подарочного сертификата.
 *
 * Механика бага: Init.Amount = order.grandTotal, УЖЕ уменьшенный на
 * gift_discount_total (lib/orders/repository.ts — finalGrandTotal), а позиции
 * чека уменьшались только на discountTotal. Инвариант Σ Items.Amount ===
 * Init.Amount (receipt.ts) срабатывал ДЕТЕРМИНИРОВАННО на любом заказе,
 * оплаченном сертификатом при TBANK_RECEIPT_ENABLED: Init падал на уже
 * созданном заказе с уже списанным балансом сертификата.
 *
 * Решение (консистентно с уже существующей обработкой discountTotal): списание
 * сертификата распределяется ПО ПОЗИЦИЯМ ТОВАРОВ ровно тем же largest-remainder
 * алгоритмом, что и промо-скидка. Доставка не дисконтируется — сертификат её и
 * не покрывает (pricing.applyGiftCertificate: amountDue = itemsTotal − promo).
 *
 * Чистые юнит-тесты: без сети/БД. Все суммы заказа — РУБЛИ-строки NUMERIC(14,2),
 * суммы чека — целые КОПЕЙКИ.
 */

function order(extra: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    number: '2026-000123',
    status: 'awaiting_payment',
    itemsTotal: '1500.00',
    discountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '1500.00',
    currency: 'RUB',
    // Снимок валюты отображения (0059): заказ оформлен в базовой валюте → null.
    displayCurrency: null,
    displayRate: null,
    displayTotal: null,
    paymentMethod: 'card',
    paymentStatus: 'pending',
    paidAt: null,
    paymentRef: null,
    paymentInitiatedAt: null,
    paymentProvider: null,
    deliveryType: 'pvz',
    isPostamat: false,
    deliveryStatus: 'pending',
    deliveryCity: null,
    deliveryAddress: null,
    deliveryPvzCode: null,
    deliveryZoneId: null,
    deliveryZoneLabel: null,
    deliveryCost: null,
    cdekUuid: null,
    cdekTrack: null,
    promoCodeId: null,
    promoCode: null,
    giftCertificateId: null,
    giftDiscountTotal: '0.00',
    customerId: null,
    customerName: 'Иван',
    customerEmail: 'buyer@example.com',
    customerPhone: '+79991234567',
    comment: '',
    idempotencyKey: null,
    source: 'storefront',
    ip: null,
    createdAt: new Date('2026-06-16T10:00:00Z'),
    updatedAt: new Date('2026-06-16T10:00:00Z'),
    ...extra,
  };
}

function item(extra: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'i1',
    orderId: 'o1',
    productId: null,
    variantId: null,
    nameSnapshot: 'Товар',
    skuSnapshot: 'SKU-1',
    attributesSnapshot: {},
    unitPrice: '500.00',
    compareAtSnapshot: null,
    quantity: 3,
    lineTotal: '1500.00',
    isGift: false,
    weightG: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    createdAt: new Date('2026-06-16T10:00:00Z'),
    ...extra,
  };
}

const CFG_WITH_TAX = getTbankConfig({
  NODE_ENV: 'test',
  TBANK_TAXATION: 'usn_income',
  TBANK_DEFAULT_TAX: 'none',
});

describe('tbank/receipt — списание подарочного сертификата (аудит major #14)', () => {
  it('регрессия: сертификат частично покрывает заказ — Init не падает, Σ = grand_total', () => {
    // itemsTotal 1500, сертификат 500 → grand_total 1000 (записан в orders).
    const o = order({
      grandTotal: '1000.00',
      giftDiscountTotal: '500.00',
      giftCertificateId: 'g1',
    });
    // До фикса здесь бросался TbankError('tbank_receipt_mismatch'): 150000 !== 100000.
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    expect(r).not.toBeNull();
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
    expect(receiptTotalKop(r)).toBe(100000);
  });

  it('сертификат + промокод: обе скидки распределены, Σ = grand_total', () => {
    // items 1500 − промо 200 = 1300; сертификат 300 → grand 1000.
    const o = order({
      discountTotal: '200.00',
      promoCode: 'SALE',
      giftDiscountTotal: '300.00',
      giftCertificateId: 'g1',
      grandTotal: '1000.00',
    });
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(100000);
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
  });

  it('несколько позиций: распределение пропорционально, Σ точно = grand_total', () => {
    // items = 500*3 + 300 = 1800; сертификат 400 → grand 1400.
    const o = order({
      itemsTotal: '1800.00',
      giftDiscountTotal: '400.00',
      giftCertificateId: 'g1',
      grandTotal: '1400.00',
    });
    const items = [
      item({ id: 'i1', unitPrice: '500.00', quantity: 3, lineTotal: '1500.00' }),
      item({ id: 'i2', nameSnapshot: 'Товар 2', unitPrice: '300.00', quantity: 1, lineTotal: '300.00' }),
    ];
    const r = buildReceipt(o, items, CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(140000);
    for (const it of r.Items) {
      expect(it.Amount).toBe(it.Price * it.Quantity);
      expect(it.Amount).toBeGreaterThanOrEqual(0);
    }
  });

  it('доставка НЕ покрывается сертификатом: остаётся отдельной полной позицией', () => {
    // items 1500, доставка 300, сертификат 500 → grand = 1500 − 500 + 300 = 1300.
    const o = order({
      deliveryTotal: '300.00',
      giftDiscountTotal: '500.00',
      giftCertificateId: 'g1',
      grandTotal: '1300.00',
    });
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    const delivery = r.Items.find((i) => i.Name === 'Доставка')!;
    expect(delivery.Amount).toBe(30000); // доставка полная
    expect(receiptTotalKop(r)).toBe(130000);
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
  });

  it('остаток округления: сертификат 1.00 на 3 равные позиции — сходится до копейки', () => {
    // 3 × 100.00 = 300; сертификат 1.00 → grand 299.00. 100 коп / 3 = 33.33…
    const o = order({
      itemsTotal: '300.00',
      giftDiscountTotal: '1.00',
      giftCertificateId: 'g1',
      grandTotal: '299.00',
    });
    const items = [
      item({ id: 'i1', unitPrice: '100.00', quantity: 1, lineTotal: '100.00' }),
      item({ id: 'i2', nameSnapshot: 'B', unitPrice: '100.00', quantity: 1, lineTotal: '100.00' }),
      item({ id: 'i3', nameSnapshot: 'C', unitPrice: '100.00', quantity: 1, lineTotal: '100.00' }),
    ];
    const r = buildReceipt(o, items, CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(29900);
  });

  it('полное покрытие сертификатом (к оплате 0): позиции обнулены, инвариант не проверяется', () => {
    // items 1500, сертификат 1500 → grand 0. Init такой заказ не инициирует
    // (fullyGiftCovered → manual/paid), но чек обязан быть согласованным.
    const o = order({
      giftDiscountTotal: '1500.00',
      giftCertificateId: 'g1',
      grandTotal: '0.00',
    });
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(0);
    for (const it of r.Items) expect(it.Amount).toBeGreaterThanOrEqual(0);
  });

  it('сертификат покрывает товары полностью, к оплате только доставка', () => {
    // items 1500, доставка 300, сертификат 1500 → grand 300.
    const o = order({
      deliveryTotal: '300.00',
      giftDiscountTotal: '1500.00',
      giftCertificateId: 'g1',
      grandTotal: '300.00',
    });
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(30000);
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
    const delivery = r.Items.find((i) => i.Name === 'Доставка')!;
    expect(delivery.Amount).toBe(30000);
  });

  it('инвариант :123-127 НЕ ослаблен: рассогласованный заказ по-прежнему бросает', () => {
    // Битые данные: grand_total не соответствует ни одной комбинации скидок.
    const o = order({ grandTotal: '999.00', giftDiscountTotal: '0.00' });
    expect(() => buildReceipt(o, [item()], CFG_WITH_TAX)).toThrowError(
      /tbank_receipt_mismatch|не равна Init\.Amount/,
    );
  });
});
