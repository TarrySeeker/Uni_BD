/**
 * Деньги и состав чека АТОЛ Pay — чистая арифметика, без сети и БД.
 *
 * 🔴 Здесь сходятся три ловушки сразу:
 *   • суммы в КОПЕЙКАХ, количество в ТЫСЯЧНЫХ;
 *   • сумма позиций обязана сойтись с суммой платежа ДО КОПЕЙКИ, иначе АТОЛ
 *     отвечает INVALID_RECEIPT_AMOUNT и оплата не стартует вовсе;
 *   • скидка не может быть «забыта»: у АТОЛа нет сокращённого режима, как у
 *     Озона, — чек уходит либо полным и сходящимся, либо никаким.
 */

import { describe, it, expect } from 'vitest';

import type { Order, OrderItem } from '@/lib/orders/types';
import { rublesToKopecks, unitsToThousandths, buildPositions } from '@/lib/payments/atol/money';

/** Пример фискальных реквизитов: УСН Доход (1), «Без НДС» (5). */
const FISCAL = { sno: 1, tax: 5, productSubject: 0, deliverySubject: 3, paymentMethod: 0 } as const;

function order(over: Partial<Order> = {}): Order {
  return {
    id: 'o-1',
    number: 'NM-1001',
    itemsTotal: '1000.00',
    discountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '1000.00',
    ...over,
  } as Order;
}

function item(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'i-1',
    nameSnapshot: 'Аметист друза',
    unitPrice: '1000.00',
    quantity: 1,
    lineTotal: '1000.00',
    ...over,
  } as OrderItem;
}

describe('atol/money — рубли → копейки', () => {
  /**
   * Строковый разбор, а не float: 0.1 + 0.2 в двоичной плавающей точке не равно
   * 0.3, и на суммах заказа это даёт расхождение в копейку — ровно то, из-за
   * чего АТОЛ отвергает платёж.
   */
  it('копейки считаются точно, без плавающей точки', () => {
    expect(rublesToKopecks('1000.00')).toBe(100000);
    expect(rublesToKopecks('0.01')).toBe(1);
    expect(rublesToKopecks('0.10')).toBe(10);
    expect(rublesToKopecks('1234.56')).toBe(123456);
    expect(rublesToKopecks('0.1')).toBe(10);
    expect(rublesToKopecks('0')).toBe(0);
  });

  it('🔴 классическая ловушка 0.1+0.2 не даёт расхождения', () => {
    expect(rublesToKopecks('0.1') + rublesToKopecks('0.2')).toBe(rublesToKopecks('0.3'));
  });

  it('целые рубли без дробной части', () => {
    expect(rublesToKopecks('99')).toBe(9900);
    expect(rublesToKopecks(99)).toBe(9900);
  });

  /**
   * 🔴 Мусор — это ОШИБКА, а не «ноль копеек». Тихий ноль глушил бы сверку
   * недоплаты: ничто не меньше нуля, то есть проверка, защищающая деньги,
   * стала бы тождественно истинной и пропускала любую сумму.
   */
  it('🔴 невалидная сумма бросает, а не возвращает 0', () => {
    expect(() => rublesToKopecks('не число')).toThrow();
    expect(() => rublesToKopecks('')).toThrow();
    expect(() => rublesToKopecks('12,50')).toThrow();
    expect(() => rublesToKopecks(Number.NaN)).toThrow();
  });
});

describe('atol/money — 🔴 количество в ТЫСЯЧНЫХ', () => {
  /**
   * 🔴 999000 = 999 штук. Передать сюда просто 999 значит пробить чек на
   * 0,999 штуки — и сумма позиций не сойдётся с суммой платежа.
   */
  it('1 шт = 1000, 999 шт = 999000', () => {
    expect(unitsToThousandths(1)).toBe(1000);
    expect(unitsToThousandths(999)).toBe(999000);
    expect(unitsToThousandths(3)).toBe(3000);
  });
});

describe('atol/money — состав чека', () => {
  it('позиция товара переносится с ценой в копейках и количеством в тысячных', () => {
    const positions = buildPositions(order(), [item({ quantity: 2, unitPrice: '500.00' })], FISCAL);
    expect(positions).not.toBeNull();
    expect(positions!).toHaveLength(1);
    expect(positions![0]).toMatchObject({
      name: 'Аметист друза',
      price: 50000,
      quantity: 2000,
      tax: 5,
      paymentSubject: 0,
      paymentMethod: 0,
      measure: 0,
    });
  });

  it('доставка идёт ОТДЕЛЬНОЙ позицией как услуга', () => {
    const o = order({ deliveryTotal: '350.00', grandTotal: '1350.00' });
    const positions = buildPositions(o, [item()], FISCAL);
    expect(positions).toHaveLength(2);
    const delivery = positions!.at(-1)!;
    expect(delivery.name).toMatch(/оставка/);
    expect(delivery.price).toBe(35000);
    expect(delivery.quantity).toBe(1000);
    // 3 = услуга: доставка не «товар», это разные признаки предмета расчёта.
    expect(delivery.paymentSubject).toBe(3);
  });

  /**
   * 🔴 ГЛАВНОЕ СВОЙСТВО. Что бы ни пришло на вход, сумма позиций обязана
   * совпасть с итогом заказа до копейки — иначе INVALID_RECEIPT_AMOUNT.
   */
  it('🔴 сумма позиций сходится с итогом заказа', () => {
    const o = order({ itemsTotal: '1000.00', deliveryTotal: '350.00', grandTotal: '1350.00' });
    const positions = buildPositions(o, [item()], FISCAL)!;
    const sum = positions.reduce((acc, p) => acc + (p.price * p.quantity) / 1000, 0);
    expect(sum).toBe(rublesToKopecks(o.grandTotal));
  });

  /**
   * 🔴 Скидка. У Озона при скидке чек уходил «сокращённым» (без состава), у
   * АТОЛа так нельзя. Скидка разносится по позициям, и сумма всё равно обязана
   * сойтись — это и проверяем.
   */
  it('🔴 скидка разносится по позициям, сумма сходится', () => {
    const o = order({
      itemsTotal: '1000.00',
      discountTotal: '100.00',
      deliveryTotal: '0.00',
      grandTotal: '900.00',
    });
    const positions = buildPositions(o, [item({ quantity: 2, unitPrice: '500.00' })], FISCAL)!;
    const sum = positions.reduce((acc, p) => acc + (p.price * p.quantity) / 1000, 0);
    expect(sum).toBe(rublesToKopecks('900.00'));
  });

  /**
   * 🔴 Неделящаяся скидка — место, где обычно и появляется расхождение в
   * копейку: 100 ₽ на 3 позиции нацело не делятся. Остаток обязан быть
   * распределён, а не отброшен.
   */
  it('🔴 неделящаяся нацело скидка не теряет копейки', () => {
    const o = order({
      itemsTotal: '300.00',
      discountTotal: '100.00',
      deliveryTotal: '0.00',
      grandTotal: '200.00',
    });
    const items = [
      item({ id: 'a', unitPrice: '100.00', quantity: 1 }),
      item({ id: 'b', unitPrice: '100.00', quantity: 1 }),
      item({ id: 'c', unitPrice: '100.00', quantity: 1 }),
    ];
    const positions = buildPositions(o, items, FISCAL)!;
    const sum = positions.reduce((acc, p) => acc + (p.price * p.quantity) / 1000, 0);
    expect(sum).toBe(rublesToKopecks('200.00'));
    // Каждая цена — целое число копеек: дробных копеек в чеке не бывает.
    for (const p of positions) expect(Number.isInteger(p.price)).toBe(true);
  });

  /**
   * Подарочная позиция с нулевой ценой законна (промокод gift_*), но чек с
   * нулевой позицией АТОЛ принимает — важно лишь, чтобы сумма сошлась.
   */
  it('позиция с нулевой ценой не ломает сверку', () => {
    const o = order({ itemsTotal: '1000.00', grandTotal: '1000.00' });
    const items = [item(), item({ id: 'gift', unitPrice: '0.00', quantity: 1, nameSnapshot: 'Подарок' })];
    const positions = buildPositions(o, items, FISCAL)!;
    const sum = positions.reduce((acc, p) => acc + (p.price * p.quantity) / 1000, 0);
    expect(sum).toBe(rublesToKopecks('1000.00'));
  });

  /**
   * 🔴 Если свести концы не удалось — возвращаем null и НЕ отправляем чек.
   * Молча отправить несходящийся чек нельзя: это либо отказ АТОЛа, либо, хуже,
   * пробитый чек с неверной суммой (54-ФЗ).
   */
  it('🔴 при несводимом расхождении возвращаем null, а не кривой чек', () => {
    const o = order({ itemsTotal: '1000.00', grandTotal: '777.77', discountTotal: '0.00' });
    expect(buildPositions(o, [item()], FISCAL)).toBeNull();
  });

  it('длинное название обрезается до предела АТОЛа', () => {
    const long = 'Кварц '.repeat(60);
    const positions = buildPositions(order(), [item({ nameSnapshot: long })], FISCAL)!;
    expect(positions[0].name.length).toBeLessThanOrEqual(128);
  });
});
