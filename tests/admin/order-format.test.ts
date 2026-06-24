import { describe, it, expect } from 'vitest';

import {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
  deliveryTypeLabel,
  paymentMethodLabel,
  promoKindLabel,
  historyKindLabel,
  orderStatusBadgeClass,
  paymentStatusBadgeClass,
  deliveryStatusBadgeClass,
  formatDateTime,
  promoValueSummary,
} from '@/lib/admin/order-format';
import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_STATUSES,
  DELIVERY_TYPES,
  PAYMENT_METHODS,
  PROMO_KINDS,
  STATUS_HISTORY_KINDS,
} from '@/lib/orders/types';

/**
 * Юнит форматтеров статусов/способов/промокодов модуля orders (docs/07 §5).
 * Чистые функции — без БД/Next. Проверяем: покрытие всех литералов (нет «дыр»),
 * фолбэк для незнакомого кода, цвет-классы и компактные сводки промокода.
 */

describe('order-format — лейблы статусов (русский)', () => {
  it('заказ: каждый статус имеет непустой русский лейбл', () => {
    for (const s of ORDER_STATUSES) {
      expect(orderStatusLabel(s)).toBeTruthy();
      expect(orderStatusLabel(s)).not.toBe(s); // переведён, а не код
    }
    expect(orderStatusLabel('new')).toBe('Новый');
    expect(orderStatusLabel('cancelled')).toBe('Отменён');
  });

  it('оплата/доставка: все литералы покрыты', () => {
    for (const s of PAYMENT_STATUSES) expect(paymentStatusLabel(s)).toBeTruthy();
    for (const s of DELIVERY_STATUSES) expect(deliveryStatusLabel(s)).toBeTruthy();
    expect(paymentStatusLabel('paid')).toBe('Оплачена');
    expect(deliveryStatusLabel('in_transit')).toBe('В пути');
  });

  it('способы доставки/оплаты и типы промокода — переведены', () => {
    for (const t of DELIVERY_TYPES) expect(deliveryTypeLabel(t)).toBeTruthy();
    for (const m of PAYMENT_METHODS) expect(paymentMethodLabel(m)).toBeTruthy();
    for (const k of PROMO_KINDS) expect(promoKindLabel(k)).toBeTruthy();
    for (const k of STATUS_HISTORY_KINDS) expect(historyKindLabel(k)).toBeTruthy();
    expect(deliveryTypeLabel('pickup')).toBe('Самовывоз');
    expect(paymentMethodLabel('cod')).toBe('При получении');
    expect(promoKindLabel('free_delivery')).toBe('Бесплатная доставка');
    expect(historyKindLabel('order')).toBe('Заказ');
  });

  it('незнакомый код → фолбэк (сам код, без падения)', () => {
    expect(orderStatusLabel('weird')).toBe('weird');
    expect(paymentStatusLabel('xyz')).toBe('xyz');
    expect(promoKindLabel('???')).toBe('???');
  });
});

describe('order-format — цвет-классы бейджей', () => {
  it('известный статус → ненейтральный класс', () => {
    expect(orderStatusBadgeClass('completed')).toContain('green');
    expect(paymentStatusBadgeClass('paid')).toContain('green');
    expect(deliveryStatusBadgeClass('delivered')).toContain('green');
  });
  it('каждый литерал имеет класс', () => {
    for (const s of ORDER_STATUSES) expect(orderStatusBadgeClass(s)).toBeTruthy();
    for (const s of PAYMENT_STATUSES) expect(paymentStatusBadgeClass(s)).toBeTruthy();
    for (const s of DELIVERY_STATUSES) expect(deliveryStatusBadgeClass(s)).toBeTruthy();
  });
  it('незнакомый код → нейтральный серый', () => {
    expect(orderStatusBadgeClass('weird')).toContain('gray');
    expect(paymentStatusBadgeClass('weird')).toContain('gray');
    expect(deliveryStatusBadgeClass('weird')).toContain('gray');
  });
});

describe('order-format — formatDateTime', () => {
  it('форматирует дату ru-RU', () => {
    const out = formatDateTime(new Date('2026-06-15T10:30:00Z'));
    expect(out).toMatch(/2026/);
    expect(out).not.toBe('—');
  });
  it('null/невалидное → «—»', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('order-format — promoValueSummary', () => {
  it('percent → «N %»', () => {
    expect(promoValueSummary({ kind: 'percent', value: '20' })).toBe('20 %');
  });
  it('free_delivery → текст', () => {
    expect(promoValueSummary({ kind: 'free_delivery', value: '0' })).toBe('беспл. доставка');
  });
  it('bogo → «N по M» при заданных qty, иначе плейсхолдер', () => {
    expect(
      promoValueSummary({ kind: 'bogo', value: '0', bogoBuyQty: 3, bogoPayQty: 2 }),
    ).toBe('3 по 2');
    expect(promoValueSummary({ kind: 'bogo', value: '0' })).toBe('N по M');
  });
  it('fixed → сырое значение (форматирует вызывающий через formatPrice)', () => {
    expect(promoValueSummary({ kind: 'fixed', value: '500.00' })).toBe('500.00');
  });
});
