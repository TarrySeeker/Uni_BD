import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Юнит-тесты мультипровайдерного refund-диспетчера (docs/24 §7, ADR-P1-3).
 *
 * Проверяем МАРШРУТИЗАЦИЮ по orders.payment_provider БЕЗ БД/сети: сервисы tbank и
 * paykeeper замоканы шпионами. Ключевое (SECURITY): неизвестный НЕ-null провайдер
 * НЕ дефолтит в tbank, а бросает ошибку; NULL (COD) не идёт в tbank; каждый
 * известный провайдер маршрутизируется в свой путь.
 */

const tbankRefundMock = vi.fn(async (..._a: unknown[]) => ({
  ok: true,
  status: 'REFUNDED',
  isMock: true,
  skipped: false,
}));
const paykeeperRefundMock = vi.fn(async (..._a: unknown[]) => ({
  ok: true,
  status: null,
  isMock: true,
  skipped: true,
  reason: 'manual',
}));
const alfabankRefundMock = vi.fn(async (..._a: unknown[]) => ({
  ok: true,
  status: '0',
  isMock: true,
  skipped: false,
}));

vi.mock('@/lib/payments/tbank', () => ({
  PaymentService: class {
    refundPayment(...a: unknown[]) {
      return tbankRefundMock(...(a as []));
    }
  },
}));
vi.mock('@/lib/payments/paykeeper', () => ({
  PaymentService: class {
    refundPayment(...a: unknown[]) {
      return paykeeperRefundMock(...(a as []));
    }
  },
}));
vi.mock('@/lib/payments/alfabank', () => ({
  PaymentService: class {
    refundPayment(...a: unknown[]) {
      return alfabankRefundMock(...(a as []));
    }
  },
}));

import { dispatchRefund, type RefundDispatchInput } from '@/lib/payments/dispatch';
import { OrderError } from '@/lib/orders/errors';

function input(over: Partial<RefundDispatchInput> = {}): RefundDispatchInput {
  return {
    orderId: 'o-1',
    orderNumber: 'ADMIK-2026-000001',
    paymentStatus: 'paid',
    paymentProvider: 'tbank',
    paymentRef: 'pay-1',
    amountKop: 100000,
    ...over,
  };
}

beforeEach(() => {
  tbankRefundMock.mockClear();
  paykeeperRefundMock.mockClear();
  alfabankRefundMock.mockClear();
});

describe('dispatchRefund — маршрутизация по payment_provider', () => {
  it('tbank → tbank.refundPayment (paykeeper НЕ вызван), результат проброшен', async () => {
    const res = await dispatchRefund(input({ paymentProvider: 'tbank' }));
    expect(tbankRefundMock).toHaveBeenCalledTimes(1);
    expect(paykeeperRefundMock).not.toHaveBeenCalled();
    // Тот же input проброшен в шлюз (суммы/реквизиты серверные).
    expect(tbankRefundMock.mock.calls[0]![0]).toMatchObject({
      paymentProvider: 'tbank',
      paymentRef: 'pay-1',
      amountKop: 100000,
    });
    expect(res).toMatchObject({ ok: true, status: 'REFUNDED' });
  });

  it('paykeeper → paykeeper.refundPayment (tbank НЕ вызван)', async () => {
    const res = await dispatchRefund(input({ paymentProvider: 'paykeeper', paymentRef: 'inv-9' }));
    expect(paykeeperRefundMock).toHaveBeenCalledTimes(1);
    expect(tbankRefundMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, skipped: true, reason: 'manual' });
  });

  it('alfabank → alfabank.refundPayment (tbank/paykeeper НЕ вызваны)', async () => {
    const res = await dispatchRefund(input({ paymentProvider: 'alfabank', paymentRef: 'alfa-9' }));
    expect(alfabankRefundMock).toHaveBeenCalledTimes(1);
    expect(tbankRefundMock).not.toHaveBeenCalled();
    expect(paykeeperRefundMock).not.toHaveBeenCalled();
    expect(alfabankRefundMock.mock.calls[0]![0]).toMatchObject({
      paymentProvider: 'alfabank',
      paymentRef: 'alfa-9',
    });
    expect(res).toMatchObject({ ok: true, status: '0' });
  });

  it('manual → внутренний skipped БЕЗ внешнего вызова', async () => {
    const res = await dispatchRefund(input({ paymentProvider: 'manual', paymentRef: null }));
    expect(tbankRefundMock).not.toHaveBeenCalled();
    expect(paykeeperRefundMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, skipped: true, reason: 'manual' });
  });

  it('gift → внутренний skip (ортогонально: возврат баланса делает releaseGiftTx в сетле), внешних вызовов нет', async () => {
    const res = await dispatchRefund(input({ paymentProvider: 'gift' }));
    expect(tbankRefundMock).not.toHaveBeenCalled();
    expect(paykeeperRefundMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, skipped: true, reason: 'gift_orthogonal' });
  });

  it('NULL (COD/офлайн) → внутренний skipped, НЕ маршрутизируется в tbank', async () => {
    const res = await dispatchRefund(input({ paymentProvider: null, paymentRef: null }));
    expect(tbankRefundMock).not.toHaveBeenCalled();
    expect(paykeeperRefundMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, skipped: true, reason: 'offline_no_provider' });
  });

  it('неизвестный НЕ-null провайдер → OrderError (НЕ дефолт-tbank), шлюзы НЕ вызваны', async () => {
    await expect(
      dispatchRefund(input({ paymentProvider: 'stripe' })),
    ).rejects.toBeInstanceOf(OrderError);
    expect(tbankRefundMock).not.toHaveBeenCalled();
    expect(paykeeperRefundMock).not.toHaveBeenCalled();
  });

  it('неизвестный провайдер: код ошибки unsupported_payment_provider', async () => {
    await expect(dispatchRefund(input({ paymentProvider: 'foobar' }))).rejects.toMatchObject({
      code: 'unsupported_payment_provider',
    });
  });
});
