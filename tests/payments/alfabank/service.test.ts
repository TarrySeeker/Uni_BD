import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Юнит-тесты PaymentService Альфа-Банка. БД/orders-репозиторий замоканы — проверяем
 * связку checksum + идемпотентная обработка + маппинг, БЕЗ живой БД.
 *
 * Проверяется:
 *   • initPayment (mock): amount = toMinor(grand_total) В КОПЕЙКАХ в demo-URL,
 *     сохранение orderId (payment_ref), гард isOrderPayable, formUrl + isMock;
 *   • handleCallback: без секрета checksum не требуется (verified:true);
 *     с секретом — невалидный checksum → verified:false; deposited:1 → paid;
 *     refunded:1 → refunded; неуспех (status 0) → переход не применяется;
 *     дубликат → duplicate:true; заказ не найден → verified:true без записи;
 *   • refundPayment (mock): успех / пропуски (no_gateway/not_captured);
 *   • confirmMockPayment: привязка к payment_ref.
 */

import { signCallback } from '@/lib/payments/alfabank/token';
import type { AlfabankCallbackParams } from '@/lib/payments/alfabank/types';

const SECRET = 'hmac-secret';

// --- Мок репозитория (без БД). ---
const recordWebhookEventMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ inserted: true, processed: true }),
);
const setPaymentRefAndProviderMock = vi.fn((..._a: unknown[]) => Promise.resolve());
const findOrderIdByRefMock = vi.fn((..._a: unknown[]) => Promise.resolve<string | null>(null));
const insertPaymentLogMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ inserted: true, id: 'log-1' }),
);

vi.mock('@/lib/payments/alfabank/repository', () => ({
  recordWebhookEvent: (...a: unknown[]) => recordWebhookEventMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefAndProviderMock(...a),
  findOrderIdByRef: (...a: unknown[]) => findOrderIdByRefMock(...a),
  insertPaymentLog: (...a: unknown[]) => insertPaymentLogMock(...a),
}));

const getOrderByNumberMock = vi.fn();
vi.mock('@/lib/orders/repository', () => ({
  getOrderByNumber: (...a: unknown[]) => getOrderByNumberMock(...a),
}));

import { AlfabankManager } from '@/lib/payments/alfabank/manager';
import { getAlfabankConfig } from '@/lib/payments/alfabank/config';
import { PaymentService } from '@/lib/payments/alfabank/service';
import { AlfabankError } from '@/lib/payments/alfabank/errors';

const MOCK_CFG = getAlfabankConfig({ NODE_ENV: 'test' });
const MOCK_CFG_SECRET = getAlfabankConfig({ NODE_ENV: 'test', ALFABANK_CALLBACK_SECRET: SECRET });
const LIVE_CFG_SECRET = getAlfabankConfig({
  NODE_ENV: 'test',
  ALFABANK_USERNAME: 'u',
  ALFABANK_PASSWORD: 'p',
  ALFABANK_CALLBACK_SECRET: SECRET,
});

function mockService(): PaymentService {
  return new PaymentService(new AlfabankManager({ config: MOCK_CFG }));
}
/** mock-режим (нет USERNAME/PASSWORD), но с checksum-секретом → checksum проверяется. */
function mockServiceWithSecret(): PaymentService {
  return new PaymentService(new AlfabankManager({ config: MOCK_CFG_SECRET }));
}
function liveService(): PaymentService {
  return new PaymentService(
    new AlfabankManager({ config: LIVE_CFG_SECRET, fetchImpl: vi.fn() as unknown as typeof fetch }),
  );
}

function fakeOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'order-uuid-1',
    number: 'ADMIK-2026-000042',
    status: 'new',
    grandTotal: '1500.00',
    paymentStatus: 'pending',
    customerEmail: 'buyer@example.com',
    customerPhone: '+79990000000',
    customerName: 'Buyer',
    paymentRef: null,
    ...over,
  };
}

function callback(over: Partial<AlfabankCallbackParams> = {}): AlfabankCallbackParams {
  const base: AlfabankCallbackParams = {
    mdOrder: 'alfa-778899',
    orderNumber: 'ADMIK-2026-000042',
    operation: 'deposited',
    status: '1',
    checksum: '',
    rest: {},
  };
  const merged: AlfabankCallbackParams = { ...base, ...over };
  if (over.checksum === undefined) {
    // Пересчитываем checksum под текущие поля (как это сделал бы банк).
    merged.checksum = signCallback(
      {
        ...merged.rest,
        mdOrder: merged.mdOrder,
        orderNumber: merged.orderNumber,
        operation: merged.operation,
        status: merged.status,
      },
      SECRET,
    );
  }
  return merged;
}

beforeEach(() => {
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue({ inserted: true, processed: true });
  setPaymentRefAndProviderMock.mockReset();
  setPaymentRefAndProviderMock.mockResolvedValue(undefined);
  findOrderIdByRefMock.mockReset();
  findOrderIdByRefMock.mockResolvedValue(null);
  insertPaymentLogMock.mockReset();
  insertPaymentLogMock.mockResolvedValue({ inserted: true, id: 'log-1' });
  getOrderByNumberMock.mockReset();
  getOrderByNumberMock.mockResolvedValue({ order: { id: 'order-uuid-1' }, items: [] });
});

describe('alfabank/service — initPayment (mock)', () => {
  it('amount В КОПЕЙКАХ (toMinor), orderId сохранён, formUrl + isMock', async () => {
    const res = await mockService().initPayment(fakeOrder() as never, []);
    expect(res.isMock).toBe(true);
    expect(res.paymentId).toMatch(/^mock-alfa-/);
    // demo-formUrl несёт amount в копейках (не рубли).
    const amount = new URL(res.paymentUrl, 'http://x').searchParams.get('amount');
    expect(amount).toBe('150000');
    expect(setPaymentRefAndProviderMock).toHaveBeenCalledWith('order-uuid-1', res.paymentId);
  });

  it('гард: отменённый заказ нельзя оплатить → AlfabankError', async () => {
    await expect(
      mockService().initPayment(fakeOrder({ status: 'cancelled' }) as never, []),
    ).rejects.toBeInstanceOf(AlfabankError);
    expect(setPaymentRefAndProviderMock).not.toHaveBeenCalled();
  });

  it('гард: уже оплаченный платёж нельзя переоплатить → AlfabankError', async () => {
    await expect(
      mockService().initPayment(fakeOrder({ paymentStatus: 'paid' }) as never, []),
    ).rejects.toBeInstanceOf(AlfabankError);
  });

  it('нулевая сумма → AlfabankError', async () => {
    await expect(
      mockService().initPayment(fakeOrder({ grandTotal: '0.00' }) as never, []),
    ).rejects.toBeInstanceOf(AlfabankError);
  });
});

describe('alfabank/service — handleCallback', () => {
  it('без секрета checksum не требуется → verified:true, deposited:1 → paid', async () => {
    findOrderIdByRefMock.mockResolvedValue('order-uuid-1');
    const cb = callback({ checksum: '' }); // секрета нет → checksum игнорируется
    const res = await mockService().handleCallback(cb);
    expect(res.verified).toBe(true);
    expect(res.processed).toBe(true);
    expect(res.paymentStatus).toBe('paid');
    const arg = recordWebhookEventMock.mock.calls[0]![0] as {
      nextStatus: string;
      log: { status: string; orderRef: string };
    };
    expect(arg.nextStatus).toBe('paid');
    expect(arg.log.status).toBe('deposited:1');
    expect(arg.log.orderRef).toBe('alfa-778899');
  });

  it('с секретом: валидный checksum, deposited:1 → paid', async () => {
    findOrderIdByRefMock.mockResolvedValue('order-uuid-1');
    const res = await liveService().handleCallback(callback());
    expect(res.verified).toBe(true);
    expect(res.processed).toBe(true);
    expect(res.paymentStatus).toBe('paid');
  });

  it('с секретом: невалидный checksum → verified:false, recordWebhookEvent НЕ вызвана', async () => {
    findOrderIdByRefMock.mockResolvedValue('order-uuid-1');
    const res = await liveService().handleCallback(callback({ checksum: 'DEADBEEF' }));
    expect(res.verified).toBe(false);
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });

  it('refunded:1 → refunded', async () => {
    findOrderIdByRefMock.mockResolvedValue('order-uuid-1');
    const res = await liveService().handleCallback(callback({ operation: 'refunded' }));
    expect(res.processed).toBe(true);
    expect(res.paymentStatus).toBe('refunded');
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { nextStatus: string; log: { status: string } };
    expect(arg.nextStatus).toBe('refunded');
    expect(arg.log.status).toBe('refunded:1');
  });

  it('неуспех (status 0) → событие логируется, но переход НЕ применяется', async () => {
    findOrderIdByRefMock.mockResolvedValue('order-uuid-1');
    recordWebhookEventMock.mockResolvedValue({ inserted: true, processed: false });
    const res = await liveService().handleCallback(callback({ operation: 'deposited', status: '0' }));
    expect(res.verified).toBe(true);
    expect(res.paymentStatus).toBeNull();
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { nextStatus: string | null };
    expect(arg.nextStatus).toBeNull();
  });

  it('фолбэк: заказ по orders.number=orderNumber, когда payment_ref не найден', async () => {
    findOrderIdByRefMock.mockResolvedValue(null);
    getOrderByNumberMock.mockResolvedValue({ order: { id: 'order-by-number' }, items: [] });
    const res = await liveService().handleCallback(callback());
    expect(res.verified).toBe(true);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { log: { orderId: string } };
    expect(arg.log.orderId).toBe('order-by-number');
  });

  it('дубликат (recordWebhookEvent inserted:false) → duplicate:true', async () => {
    findOrderIdByRefMock.mockResolvedValue('order-uuid-1');
    recordWebhookEventMock.mockResolvedValue({ inserted: false, processed: false });
    const res = await liveService().handleCallback(callback());
    expect(res.duplicate).toBe(true);
    expect(res.processed).toBe(false);
  });

  it('заказ не найден, но verified → verified:true без записи', async () => {
    findOrderIdByRefMock.mockResolvedValue(null);
    getOrderByNumberMock.mockResolvedValue(null);
    const res = await liveService().handleCallback(callback());
    expect(res.verified).toBe(true);
    expect(res.processed).toBe(false);
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });

  it('mock-режим с checksum-секретом: невалидный checksum всё равно отклоняется', async () => {
    findOrderIdByRefMock.mockResolvedValue('order-uuid-1');
    const res = await mockServiceWithSecret().handleCallback(callback({ checksum: 'BAD' }));
    expect(res.verified).toBe(false);
  });
});

describe('alfabank/service — reconcile / refund / confirmMock', () => {
  it('reconcilePayment (mock): orderStatus 2 → paid, status "2"', async () => {
    const res = await mockService().reconcilePayment({
      orderId: 'order-uuid-1',
      orderNumber: 'ADMIK-2026-000042',
      paymentId: 'mock-alfa-1',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('2');
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { nextStatus: string };
    expect(arg.nextStatus).toBe('paid');
  });

  it('refundPayment (mock, paid): успех → ok, аудит-лог insertPaymentLog(admin-refund)', async () => {
    const res = await mockService().refundPayment({
      orderId: 'o',
      orderNumber: 'n',
      paymentStatus: 'paid',
      paymentProvider: 'alfabank',
      paymentRef: 'alfa-778899',
      amountKop: 150000,
    });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBeUndefined();
    const arg = insertPaymentLogMock.mock.calls[0]![0] as { status: string };
    expect(arg.status).toBe('admin-refund');
  });

  it('refundPayment: провайдер не alfabank / нет payment_ref → skipped no_gateway', async () => {
    const res = await mockService().refundPayment({
      orderId: 'o',
      orderNumber: 'n',
      paymentStatus: 'paid',
      paymentProvider: 'tbank',
      paymentRef: 'x',
      amountKop: 1,
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no_gateway');
    expect(insertPaymentLogMock).not.toHaveBeenCalled();
  });

  it('refundPayment: платёж не захвачен (pending) → skipped not_captured', async () => {
    const res = await mockService().refundPayment({
      orderId: 'o',
      orderNumber: 'n',
      paymentStatus: 'pending',
      paymentProvider: 'alfabank',
      paymentRef: 'alfa-1',
      amountKop: 1,
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('not_captured');
  });

  it('confirmMockPayment: несовпадение payment_ref → refuse', async () => {
    getOrderByNumberMock.mockResolvedValue({
      order: { id: 'order-uuid-1', paymentRef: 'other-ref', grandTotal: '1500.00' },
      items: [],
    });
    const res = await mockService().confirmMockPayment('ADMIK-2026-000042', 'mock-alfa-1');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('payment_ref_mismatch');
  });

  it('confirmMockPayment: совпадение payment_ref → ok + recordWebhookEvent(deposited:1)', async () => {
    getOrderByNumberMock.mockResolvedValue({
      order: { id: 'order-uuid-1', paymentRef: 'mock-alfa-1', grandTotal: '1500.00' },
      items: [],
    });
    const res = await mockService().confirmMockPayment('ADMIK-2026-000042', 'mock-alfa-1');
    expect(res.ok).toBe(true);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { log: { status: string }; nextStatus: string };
    expect(arg.log.status).toBe('deposited:1');
    expect(arg.nextStatus).toBe('paid');
  });
});
