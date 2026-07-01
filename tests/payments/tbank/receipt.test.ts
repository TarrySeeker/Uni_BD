import { describe, it, expect } from 'vitest';
import { buildReceipt, receiptTotalKop, toKopecks } from '@/lib/payments/tbank/receipt';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import type { Order, OrderItem } from '@/lib/orders/types';

/**
 * Юнит-тесты сборки чека 54-ФЗ (docs/15 §6). ЧИСТЫЕ, без сети/БД. КЛЮЧЕВОЙ
 * инвариант: сумма Items.Amount = Init.Amount (иначе Т-Банк отклонит).
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
    paymentMethod: 'card',
    paymentStatus: 'pending',
    paidAt: null,
    paymentRef: null,
    paymentProvider: null,
    deliveryType: 'pvz',
    deliveryStatus: 'pending',
    deliveryCity: null,
    deliveryAddress: null,
    deliveryPvzCode: null,
    deliveryCost: null,
    cdekUuid: null,
    cdekTrack: null,
    promoCodeId: null,
    promoCode: null,
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

describe('tbank/receipt — toKopecks', () => {
  it('рубли-строка NUMERIC → целые копейки', () => {
    expect(toKopecks('1500.00')).toBe(150000);
    expect(toKopecks('19.99')).toBe(1999);
    expect(toKopecks('0.00')).toBe(0);
    expect(toKopecks(100)).toBe(10000);
  });

  it('точный строковый разбор без float (19.99 → 1999, не 1998.999…)', () => {
    // Проверяем именно текстовый путь toMinor: типичные «коварные» для float значения.
    expect(toKopecks('0.10')).toBe(10);
    expect(toKopecks('0.20')).toBe(20);
    expect(toKopecks('70.07')).toBe(7007);
    expect(toKopecks('1234567.89')).toBe(123456789);
  });

  it('невалидный/мусорный вход → 0 (разумная обёртка, без throw)', () => {
    expect(toKopecks('')).toBe(0);
    expect(toKopecks('abc')).toBe(0);
    expect(toKopecks(NaN)).toBe(0);
    expect(toKopecks(Infinity)).toBe(0);
    // Отрицательное (toMinor бросает) → обёртка возвращает 0, а не падает.
    expect(toKopecks('-5.00')).toBe(0);
    // Более 2 знаков (toMinor бросает) → 0.
    expect(toKopecks('1.999')).toBe(0);
  });
});

describe('tbank/receipt — buildReceipt инвариант суммы', () => {
  it('сумма Items.Amount = grand_total в копейках (без доставки)', () => {
    const o = order();
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    expect(r).not.toBeNull();
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
    expect(r.Items).toHaveLength(1);
    expect(r.Items[0]!.Price).toBe(50000);
    expect(r.Items[0]!.Amount).toBe(150000);
    expect(r.Taxation).toBe('usn_income');
  });

  it('доставка (>0) добавляется отдельной позицией service; сумма сходится', () => {
    const o = order({ deliveryTotal: '300.00', grandTotal: '1800.00' });
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    expect(r.Items).toHaveLength(2);
    const delivery = r.Items[1]!;
    expect(delivery.Name).toBe('Доставка');
    expect(delivery.PaymentObject).toBe('service');
    expect(delivery.Amount).toBe(30000);
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
  });

  it('Email/Phone из заказа', () => {
    const r = buildReceipt(order(), [item()], CFG_WITH_TAX)!;
    expect(r.Email).toBe('buyer@example.com');
    expect(r.Phone).toBe('+79991234567');
  });
});

describe('tbank/receipt — buildReceipt скидка промокода (54-ФЗ, MAJOR)', () => {
  // КЛЮЧЕВОЙ кейс: при discountTotal>0 сумма Items.Amount БЕЗ распределения
  // скидки была бы > Init.Amount ровно на discountTotal → Т-Банк отклонит Init.
  // Чек ДОЛЖЕН распределять скидку по позициям так, чтобы Σ = grand_total.

  it('одна позиция: скидка вычитается, сумма = grand_total', () => {
    // itemsTotal 1500, скидка 200 → grand 1300.
    const o = order({ discountTotal: '200.00', grandTotal: '1300.00', promoCode: 'SALE' });
    const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
    expect(receiptTotalKop(r)).toBe(130000);
  });

  it('несколько позиций: пропорциональное распределение, сумма точно = grand_total', () => {
    // itemsTotal = 500*3 + 300*1 = 1800, скидка 100 → grand 1700.
    const o = order({
      itemsTotal: '1800.00',
      discountTotal: '100.00',
      grandTotal: '1700.00',
      promoCode: 'SALE',
    });
    const items = [
      item({ id: 'i1', unitPrice: '500.00', quantity: 3, lineTotal: '1500.00' }),
      item({ id: 'i2', nameSnapshot: 'Товар 2', unitPrice: '300.00', quantity: 1, lineTotal: '300.00' }),
    ];
    const r = buildReceipt(o, items, CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
    expect(receiptTotalKop(r)).toBe(170000);
    // Каждая позиция остаётся валидной: Amount = Price * Quantity и не отрицательна.
    for (const it of r.Items) {
      expect(it.Amount).toBe(it.Price * it.Quantity);
      expect(it.Amount).toBeGreaterThanOrEqual(0);
    }
  });

  it('скидка + доставка: доставка не дисконтируется, Σ = grand_total', () => {
    // items 1800, скидка 100, доставка 300 → grand = 1800 - 100 + 300 = 2000.
    const o = order({
      itemsTotal: '1800.00',
      discountTotal: '100.00',
      deliveryTotal: '300.00',
      grandTotal: '2000.00',
      promoCode: 'SALE',
    });
    const items = [
      item({ id: 'i1', unitPrice: '500.00', quantity: 3, lineTotal: '1500.00' }),
      item({ id: 'i2', nameSnapshot: 'Товар 2', unitPrice: '300.00', quantity: 1, lineTotal: '300.00' }),
    ];
    const r = buildReceipt(o, items, CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
    expect(receiptTotalKop(r)).toBe(200000);
    const delivery = r.Items.find((i) => i.Name === 'Доставка')!;
    expect(delivery.Amount).toBe(30000); // доставка полная, без скидки
  });

  it('распределение с остатком округления сходится точно до копейки', () => {
    // 3 равные позиции по 100.00 (itemsTotal 300), скидка 1.00 → grand 299.00.
    // 100 коп / 3 = 33.33… → остаток нужно распределить, чтобы Σ = 29900.
    const o = order({
      itemsTotal: '300.00',
      discountTotal: '1.00',
      grandTotal: '299.00',
      promoCode: 'SALE',
    });
    const items = [
      item({ id: 'i1', unitPrice: '100.00', quantity: 1, lineTotal: '100.00' }),
      item({ id: 'i2', nameSnapshot: 'B', unitPrice: '100.00', quantity: 1, lineTotal: '100.00' }),
      item({ id: 'i3', nameSnapshot: 'C', unitPrice: '100.00', quantity: 1, lineTotal: '100.00' }),
    ];
    const r = buildReceipt(o, items, CFG_WITH_TAX)!;
    expect(receiptTotalKop(r)).toBe(29900);
    expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
  });

  it('инвариант проверяется ВСЕГДА: Σ Items.Amount === Init.Amount (без скидки тоже)', () => {
    const cases: Array<Partial<Order>> = [
      { itemsTotal: '1500.00', discountTotal: '0.00', grandTotal: '1500.00' },
      { itemsTotal: '1500.00', discountTotal: '333.33', grandTotal: '1166.67' },
      { itemsTotal: '1500.00', discountTotal: '0.00', deliveryTotal: '149.00', grandTotal: '1649.00' },
    ];
    for (const extra of cases) {
      const o = order(extra);
      const r = buildReceipt(o, [item()], CFG_WITH_TAX)!;
      expect(receiptTotalKop(r)).toBe(toKopecks(o.grandTotal));
    }
  });
});

describe('tbank/receipt — buildReceipt отказы', () => {
  it('без taxation в конфиге → null (чек невозможен)', () => {
    const cfg = getTbankConfig({ NODE_ENV: 'test' }); // taxation пуст
    expect(buildReceipt(order(), [item()], cfg)).toBeNull();
  });

  it('без email и телефона → null', () => {
    const o = order({ customerEmail: '', customerPhone: '' });
    expect(buildReceipt(o, [item()], CFG_WITH_TAX)).toBeNull();
  });
});
