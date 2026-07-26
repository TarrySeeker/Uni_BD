import { describe, expect, it } from 'vitest';

import {
  classifyRefundOutcome,
  planRefundMoney,
  refundNeedsManualAck,
  refundOutcomeNote,
  type RefundMoneyOutcome,
} from '@/lib/orders/refund-policy';

/**
 * ПОЛИТИКА ВОЗВРАТА ДЕНЕГ — чистые функции (аудит 2026-07-26, критичное №7 + major №38).
 *
 * Находка: интерфейс рапортовал «Возврат: выполнено» и для случая, когда шлюзового
 * возврата НЕ БЫЛО (PayKeeper-заглушка, COD, ручной платёж, провайдер не задан) —
 * менеджер не мог отличить «деньги ушли покупателю» от «деньги надо вернуть руками».
 * Классификация исхода вынесена сюда: один смысл на оба входа («Статус заказа →
 * Возврат» и «Статус оплаты → Возврат»), тестируется без БД и сети.
 */

const OK_GATEWAY = { ok: true, skipped: false } as const;
const OK_SKIPPED = { ok: true, skipped: true, reason: 'manual' } as const;
const FAILED = { ok: false, skipped: false, reason: 'cancel_failed' } as const;

describe('classifyRefundOutcome — что на самом деле произошло с деньгами', () => {
  it('шлюз отказал → gateway_failed (заказ НЕ помечаем возвращённым)', () => {
    expect(
      classifyRefundOutcome({ paymentStatus: 'paid', amountKop: 100000, gateway: FAILED }),
    ).toBe<RefundMoneyOutcome>('gateway_failed');
  });

  it('шлюз вернул → gateway_refunded', () => {
    expect(
      classifyRefundOutcome({ paymentStatus: 'paid', amountKop: 100000, gateway: OK_GATEWAY }),
    ).toBe<RefundMoneyOutcome>('gateway_refunded');
  });

  it('деньги получены, но шлюз пропущен (заглушка/COD/manual) → manual_required', () => {
    expect(
      classifyRefundOutcome({ paymentStatus: 'paid', amountKop: 100000, gateway: OK_SKIPPED }),
    ).toBe<RefundMoneyOutcome>('manual_required');
  });

  it('оплата не поступала (pending/failed) → nothing_to_return, подтверждение не нужно', () => {
    for (const paymentStatus of ['pending', 'failed']) {
      expect(
        classifyRefundOutcome({ paymentStatus, amountKop: 100000, gateway: OK_SKIPPED }),
      ).toBe<RefundMoneyOutcome>('nothing_to_return');
    }
  });

  it('заказ полностью покрыт сертификатом (к оплате 0) → nothing_to_return', () => {
    // payment_status='paid', provider='manual' — но живых денег не было: возвращать
    // нечего, баланс сертификата восстанавливает releaseGiftTx в сетле.
    expect(
      classifyRefundOutcome({ paymentStatus: 'paid', amountKop: 0, gateway: OK_SKIPPED }),
    ).toBe<RefundMoneyOutcome>('nothing_to_return');
  });

  it('холд (authorized) без шлюзового reverse → manual_required (деньги у банка заблокированы)', () => {
    expect(
      classifyRefundOutcome({ paymentStatus: 'authorized', amountKop: 5000, gateway: OK_SKIPPED }),
    ).toBe<RefundMoneyOutcome>('manual_required');
  });

  it('сумма неизвестна (NaN) → считаем деньги полученными: подтверждение требуется', () => {
    expect(
      classifyRefundOutcome({ paymentStatus: 'paid', amountKop: Number.NaN, gateway: OK_SKIPPED }),
    ).toBe<RefundMoneyOutcome>('manual_required');
  });

  it('отрицательная/нулевая сумма не превращается в «шлюз вернул»', () => {
    expect(
      classifyRefundOutcome({ paymentStatus: 'paid', amountKop: -1, gateway: OK_GATEWAY }),
    ).toBe<RefundMoneyOutcome>('nothing_to_return');
  });
});

describe('refundNeedsManualAck — когда менеджер обязан подтвердить возврат вне системы', () => {
  it('только manual_required требует подтверждения', () => {
    expect(refundNeedsManualAck('manual_required')).toBe(true);
    expect(refundNeedsManualAck('gateway_refunded')).toBe(false);
    expect(refundNeedsManualAck('nothing_to_return')).toBe(false);
    expect(refundNeedsManualAck('gateway_failed')).toBe(false);
  });
});

describe('refundOutcomeNote — след в истории заказа: деньги ушли или нет', () => {
  it('разный текст на разный денежный смысл (иначе «бумажный возврат» не отличить)', () => {
    const gateway = refundOutcomeNote('gateway_refunded');
    const manual = refundOutcomeNote('manual_required');
    const none = refundOutcomeNote('nothing_to_return');
    expect(gateway).not.toBe(manual);
    expect(manual).not.toBe(none);
    expect(gateway).not.toBe(none);
    for (const s of [gateway, manual, none]) expect(s.length).toBeGreaterThan(0);
    expect(manual).toMatch(/вне системы|вручную/i);
  });
});

describe('planRefundMoney — предсказание для UI (текст подтверждения ДО обращения к шлюзу)', () => {
  it('оплачено картой через шлюзовой эквайер → gateway', () => {
    expect(
      planRefundMoney({ paymentStatus: 'paid', paymentProvider: 'tbank', amountKop: 100000 }),
    ).toBe('gateway');
    expect(
      planRefundMoney({ paymentStatus: 'paid', paymentProvider: 'alfabank', amountKop: 100000 }),
    ).toBe('gateway');
  });

  it('оплачено через PayKeeper/офлайн → manual (шлюз деньги не вернёт)', () => {
    expect(
      planRefundMoney({ paymentStatus: 'paid', paymentProvider: 'paykeeper', amountKop: 100000 }),
    ).toBe('manual');
    expect(
      planRefundMoney({ paymentStatus: 'paid', paymentProvider: null, amountKop: 100000 }),
    ).toBe('manual');
  });

  it('оплата не поступала или к оплате 0 → none (возврат без движения денег)', () => {
    expect(
      planRefundMoney({ paymentStatus: 'pending', paymentProvider: 'tbank', amountKop: 100000 }),
    ).toBe('none');
    expect(
      planRefundMoney({ paymentStatus: 'paid', paymentProvider: 'manual', amountKop: 0 }),
    ).toBe('none');
  });
});
