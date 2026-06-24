import { describe, it, expect } from 'vitest';
import { giftQuoteLine, calculateQuote } from '@/lib/orders/pricing';

/**
 * Подарочная позиция (товар-подарок промокода gift_*, ADR-016).
 *
 * Подарок выдаётся ОТДЕЛЬНОЙ строкой с ценой 0 и считается ВНЕ итога
 * (itemsTotal/скидка/порог бесплатной доставки) — добавляется поверх расчёта.
 * Здесь проверяется чистый билдер строки-подарка; интеграция в quote/order
 * (резерв, снимок, best-effort при нехватке) — в repository.test.ts (нужна БД).
 */
describe('lib/orders/pricing — giftQuoteLine', () => {
  it('строит подарок: цена и сумма 0, compareAt = ценность, isGift=true', () => {
    const line = giftQuoteLine({ name: 'Подарок', sku: 'GIFT-1', value: '990.00', qty: 1 });
    expect(line).toEqual({
      name: 'Подарок',
      sku: 'GIFT-1',
      unitPrice: '0.00',
      compareAt: '990.00',
      qty: 1,
      lineTotal: '0.00',
      isGift: true,
    });
  });

  it('value=null → compareAt=null (подарок без каталожной «ценности»)', () => {
    const line = giftQuoteLine({ name: 'Подарок', sku: 'GIFT-2', value: null, qty: 3 });
    expect(line.compareAt).toBeNull();
    expect(line.unitPrice).toBe('0.00');
    expect(line.lineTotal).toBe('0.00');
    expect(line.qty).toBe(3);
    expect(line.isGift).toBe(true);
  });

  it('некорректный qty → ошибка', () => {
    expect(() => giftQuoteLine({ name: 'G', sku: 'G', value: '100.00', qty: 0 })).toThrow();
    expect(() => giftQuoteLine({ name: 'G', sku: 'G', value: '100.00', qty: 1.5 })).toThrow();
  });

  it('подарок не влияет на итог: добавленный к lines строкой 0 не меняет grandTotal', () => {
    // Расчёт без подарка.
    const base = calculateQuote({
      lines: [{ name: 'A', sku: 'A', unitPrice: '500.00', compareAt: null, qty: 2 }],
      delivery: { cost: '0.00', freeThreshold: 0 },
    });
    expect(base.itemsTotal).toBe('1000.00');
    expect(base.grandTotal).toBe('1000.00');
    // Подарок добавляется ПОСЛЕ расчёта (как делает repository.quoteCart):
    const withGift = {
      ...base,
      lines: [...base.lines, giftQuoteLine({ name: 'Подарок', sku: 'G', value: '300.00', qty: 1 })],
    };
    // Итоговые суммы НЕ изменились — подарок вне itemsTotal/grandTotal.
    expect(withGift.itemsTotal).toBe('1000.00');
    expect(withGift.grandTotal).toBe('1000.00');
    // Но строка-подарок присутствует и помечена.
    const gift = withGift.lines.find((l) => l.isGift);
    expect(gift?.unitPrice).toBe('0.00');
    expect(gift?.lineTotal).toBe('0.00');
  });
});
