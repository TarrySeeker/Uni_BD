import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUS_TRANSITIONS,
  PAYMENT_STATUS_TRANSITIONS,
  DELIVERY_STATUS_TRANSITIONS,
  assertTransition,
  canTransition,
  canTransitionDelivery,
  canTransitionOrder,
  canTransitionPayment,
  isTerminal,
  isOrderPayable,
  paymentStatusOnSettle,
  nextDeliveryStatuses,
  nextOrderStatuses,
  nextPaymentStatuses,
  nextStatuses,
  deliveryForwardPath,
} from '@/lib/orders/status';
import {
  DELIVERY_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} from '@/lib/orders/types';

/**
 * Тесты статус-машин (docs/07 §2.8) — чистые функции, всегда зелёные (без БД).
 * Покрывают разрешённые/запрещённые переходы, терминальные статусы, согласие
 * таблиц переходов с whitelist-значениями из types.ts.
 */

describe('orders/status — paymentStatusOnSettle (сетл оплаты при отмене/возврате)', () => {
  it('paid + отмена/возврат → refunded (деньги получены — возвращаем)', () => {
    expect(paymentStatusOnSettle('paid', 'cancelled')).toBe('refunded');
    expect(paymentStatusOnSettle('paid', 'refunded')).toBe('refunded');
  });
  it('НЕ оплачено (pending/failed/authorized) → null (деньги не списаны, refunded не штампуем)', () => {
    // Главное: COD-возврат (pending) НЕ даёт запрещённый pending→refunded.
    expect(paymentStatusOnSettle('pending', 'refunded')).toBeNull();
    expect(paymentStatusOnSettle('pending', 'cancelled')).toBeNull();
    expect(paymentStatusOnSettle('failed', 'cancelled')).toBeNull();
    expect(paymentStatusOnSettle('authorized', 'refunded')).toBeNull();
  });
  it('переход НЕ в отмену/возврат → null (оплату не трогаем)', () => {
    expect(paymentStatusOnSettle('paid', 'packed')).toBeNull();
    expect(paymentStatusOnSettle('paid', 'shipped')).toBeNull();
  });
});

describe('orders/status — статус ЗАКАЗА (§2.8 A)', () => {
  it('разрешает переходы строго по таблице docs/07 §2.8 A', () => {
    expect(canTransitionOrder('new', 'awaiting_payment')).toBe(true);
    expect(canTransitionOrder('new', 'paid')).toBe(true);
    expect(canTransitionOrder('new', 'cancelled')).toBe(true);
    expect(canTransitionOrder('awaiting_payment', 'paid')).toBe(true);
    expect(canTransitionOrder('paid', 'packed')).toBe(true);
    expect(canTransitionOrder('paid', 'refunded')).toBe(true);
    expect(canTransitionOrder('packed', 'shipped')).toBe(true);
    expect(canTransitionOrder('shipped', 'delivered')).toBe(true);
    expect(canTransitionOrder('delivered', 'completed')).toBe(true);
    expect(canTransitionOrder('completed', 'refunded')).toBe(true);
  });

  it('запрещает переходы вне таблицы', () => {
    expect(canTransitionOrder('new', 'shipped')).toBe(false);
    expect(canTransitionOrder('new', 'completed')).toBe(false);
    // cancelled недоступен после отгрузки (нет shipped→cancelled, §6):
    expect(canTransitionOrder('shipped', 'cancelled')).toBe(false);
    expect(canTransitionOrder('delivered', 'cancelled')).toBe(false);
    // refunded только после оплаты — не из new/awaiting_payment:
    expect(canTransitionOrder('new', 'refunded')).toBe(false);
    expect(canTransitionOrder('awaiting_payment', 'refunded')).toBe(false);
    // назад нельзя:
    expect(canTransitionOrder('paid', 'new')).toBe(false);
  });

  it('переход в тот же статус недопустим (no-op не нужен)', () => {
    expect(canTransitionOrder('new', 'new')).toBe(false);
    expect(canTransitionOrder('paid', 'paid')).toBe(false);
  });

  it('cancelled и refunded — терминальные статусы заказа', () => {
    expect(isTerminal('order', 'cancelled')).toBe(true);
    expect(isTerminal('order', 'refunded')).toBe(true);
    expect(nextOrderStatuses('cancelled')).toEqual([]);
    expect(nextOrderStatuses('refunded')).toEqual([]);
    expect(isTerminal('order', 'new')).toBe(false);
  });

  it('cancelled доступен из любого статуса ДО shipped', () => {
    for (const from of ['new', 'awaiting_payment', 'paid', 'packed'] as const) {
      expect(canTransitionOrder(from, 'cancelled')).toBe(true);
    }
    for (const from of ['shipped', 'delivered', 'completed'] as const) {
      expect(canTransitionOrder(from, 'cancelled')).toBe(false);
    }
  });
});

describe('orders/status — статус ОПЛАТЫ (§2.8 B)', () => {
  it('разрешает pending→authorized→paid и ветви failed/refunded', () => {
    expect(canTransitionPayment('pending', 'authorized')).toBe(true);
    expect(canTransitionPayment('pending', 'paid')).toBe(true);
    expect(canTransitionPayment('pending', 'failed')).toBe(true);
    expect(canTransitionPayment('authorized', 'paid')).toBe(true);
    expect(canTransitionPayment('paid', 'refunded')).toBe(true);
  });

  it('failed НЕ терминален: повторная оплата может стать authorized/paid', () => {
    // Иначе успешный ретрай после отказа Т-Банк не пометил бы заказ оплаченным.
    expect(canTransitionPayment('failed', 'pending')).toBe(true);
    expect(canTransitionPayment('failed', 'authorized')).toBe(true);
    expect(canTransitionPayment('failed', 'paid')).toBe(true);
  });

  it('запрещает недопустимые переходы оплаты', () => {
    expect(canTransitionPayment('paid', 'pending')).toBe(false);
    expect(canTransitionPayment('refunded', 'paid')).toBe(false);
    expect(canTransitionPayment('authorized', 'authorized')).toBe(false);
  });

  it('refunded — терминальный статус оплаты', () => {
    expect(isTerminal('payment', 'refunded')).toBe(true);
    expect(nextPaymentStatuses('refunded')).toEqual([]);
  });
});

describe('orders/status — статус ДОСТАВКИ (§2.8 C)', () => {
  it('разрешает pending→registered→in_transit→delivered и ветви', () => {
    expect(canTransitionDelivery('pending', 'registered')).toBe(true);
    expect(canTransitionDelivery('registered', 'in_transit')).toBe(true);
    expect(canTransitionDelivery('in_transit', 'delivered')).toBe(true);
    expect(canTransitionDelivery('in_transit', 'returned')).toBe(true);
    expect(canTransitionDelivery('pending', 'cancelled')).toBe(true);
  });

  it('запрещает недопустимые переходы доставки', () => {
    expect(canTransitionDelivery('delivered', 'in_transit')).toBe(false);
    expect(canTransitionDelivery('cancelled', 'registered')).toBe(false);
  });

  it('returned и cancelled — терминальные статусы доставки', () => {
    expect(isTerminal('delivery', 'returned')).toBe(true);
    expect(isTerminal('delivery', 'cancelled')).toBe(true);
    expect(nextDeliveryStatuses('returned')).toEqual([]);
  });
});

describe('orders/status — обобщённое ядро', () => {
  it('canTransition/nextStatuses работают по дискриминатору машины', () => {
    expect(canTransition('order', 'new', 'paid')).toBe(true);
    expect(canTransition('payment', 'pending', 'paid')).toBe(true);
    expect(canTransition('delivery', 'pending', 'registered')).toBe(true);
    expect(nextStatuses('order', 'new')).toEqual([
      'awaiting_payment',
      'paid',
      'cancelled',
    ]);
  });

  it('неизвестный исходный статус → переход недопустим, список пуст', () => {
    expect(canTransition('order', 'bogus', 'paid')).toBe(false);
    expect(nextStatuses('order', 'bogus')).toEqual([]);
    expect(isTerminal('order', 'bogus')).toBe(false);
  });

  it('assertTransition бросает при недопустимом, молчит при допустимом', () => {
    expect(() => assertTransition('order', 'new', 'paid')).not.toThrow();
    expect(() => assertTransition('order', 'new', 'shipped')).toThrow(
      /Недопустимый переход/,
    );
    expect(() => assertTransition('payment', 'paid', 'pending')).toThrow(/оплаты/);
    expect(() => assertTransition('delivery', 'delivered', 'pending')).toThrow(
      /доставки/,
    );
  });
});

describe('orders/status — целостность таблиц переходов', () => {
  it('все ключи/значения order-машины — валидные OrderStatus', () => {
    const valid = new Set<string>(ORDER_STATUSES);
    for (const [from, tos] of Object.entries(ORDER_STATUS_TRANSITIONS)) {
      expect(valid.has(from)).toBe(true);
      for (const to of tos) expect(valid.has(to)).toBe(true);
    }
    // Таблица покрывает все статусы.
    expect(Object.keys(ORDER_STATUS_TRANSITIONS).sort()).toEqual(
      [...ORDER_STATUSES].sort(),
    );
  });

  it('все ключи/значения payment-машины — валидные PaymentStatus', () => {
    const valid = new Set<string>(PAYMENT_STATUSES);
    for (const [from, tos] of Object.entries(PAYMENT_STATUS_TRANSITIONS)) {
      expect(valid.has(from)).toBe(true);
      for (const to of tos) expect(valid.has(to)).toBe(true);
    }
    expect(Object.keys(PAYMENT_STATUS_TRANSITIONS).sort()).toEqual(
      [...PAYMENT_STATUSES].sort(),
    );
  });

  it('все ключи/значения delivery-машины — валидные DeliveryStatus', () => {
    const valid = new Set<string>(DELIVERY_STATUSES);
    for (const [from, tos] of Object.entries(DELIVERY_STATUS_TRANSITIONS)) {
      expect(valid.has(from)).toBe(true);
      for (const to of tos) expect(valid.has(to)).toBe(true);
    }
    expect(Object.keys(DELIVERY_STATUS_TRANSITIONS).sort()).toEqual(
      [...DELIVERY_STATUSES].sort(),
    );
  });
});

describe('isOrderPayable — backend-инвариант оплачиваемости (БАГ #11)', () => {
  it('БЛОКИРУЕТ оплату отменённого/возвращённого ЗАКАЗА (даже при payment=pending)', () => {
    expect(isOrderPayable('cancelled', 'pending')).toBe(false);
    expect(isOrderPayable('refunded', 'pending')).toBe(false);
    expect(isOrderPayable('cancelled', 'failed')).toBe(false);
  });

  it('БЛОКИРУЕТ повторную оплату уже оплаченного/возвращённого ПЛАТЕЖА', () => {
    expect(isOrderPayable('paid', 'paid')).toBe(false);
    expect(isOrderPayable('paid', 'refunded')).toBe(false);
  });

  it('ДОПУСКАЕТ активный заказ с pending/failed/authorized (вкл. ретрай failed)', () => {
    expect(isOrderPayable('new', 'pending')).toBe(true);
    expect(isOrderPayable('awaiting_payment', 'pending')).toBe(true);
    expect(isOrderPayable('paid', 'failed')).toBe(true); // ретрай неуспешной оплаты
    expect(isOrderPayable('new', 'authorized')).toBe(true);
  });
});

describe('deliveryForwardPath — пошаговая докрутка доставки до target (C4-2)', () => {
  it('канонический прыжок registered → delivered докручивается через in_transit', () => {
    // СДЭК прислал сразу DELIVERED (потерян in_transit): путь должен пройти его.
    expect(deliveryForwardPath('registered', 'delivered')).toEqual([
      'in_transit',
      'delivered',
    ]);
  });

  it('pending → delivered = вся цепь [registered, in_transit, delivered]', () => {
    expect(deliveryForwardPath('pending', 'delivered')).toEqual([
      'registered',
      'in_transit',
      'delivered',
    ]);
  });

  it('смежный шаг in_transit → delivered = [delivered]', () => {
    expect(deliveryForwardPath('in_transit', 'delivered')).toEqual(['delivered']);
  });

  it('прямое ребро registered → cancelled = [cancelled] (без синтетических шагов)', () => {
    expect(deliveryForwardPath('registered', 'cancelled')).toEqual(['cancelled']);
  });

  it('ветвь возврата registered → returned проходит через in_transit', () => {
    expect(deliveryForwardPath('registered', 'returned')).toEqual([
      'in_transit',
      'returned',
    ]);
  });

  it('from === to → [] (уже в целевом статусе, нечего применять)', () => {
    expect(deliveryForwardPath('delivered', 'delivered')).toEqual([]);
  });

  it('назад недостижимо: delivered → registered → []', () => {
    expect(deliveryForwardPath('delivered', 'registered')).toEqual([]);
  });

  it('нет ребра вперёд: in_transit → cancelled → []', () => {
    expect(deliveryForwardPath('in_transit', 'cancelled')).toEqual([]);
  });

  it('каждый шаг пути — валидный переход canTransition(delivery)', () => {
    // Инвариант: применяя путь по шагам, мы НЕ нарушаем статус-машину.
    const path = deliveryForwardPath('pending', 'delivered');
    let prev = 'pending';
    for (const step of path) {
      expect(canTransition('delivery', prev, step)).toBe(true);
      prev = step;
    }
    expect(prev).toBe('delivered');
  });
});
