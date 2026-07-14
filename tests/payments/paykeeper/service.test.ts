import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Юнит-тесты PaymentService PayKeeper (docs/24 §2). БД/orders-репозиторий замоканы
 * — проверяем связку подпись + идемпотентная обработка + маппинг, БЕЗ живой БД.
 *
 * Проверяется:
 *   • initPayment (mock): pay_amount = normalizeMoney(grand_total) В РУБЛЯХ,
 *     сохранение invoice_id, гард isOrderPayable;
 *   • handleCallback: невалидная подпись → verified:false, ack:null;
 *     валидная → recordWebhookEvent(nextStatus='paid'), ack = `OK `+md5(id+secret);
 *     дубликат → duplicate:true, ack всё равно есть;
 *     заказ не найден → verified:true, ack есть (PayKeeper должен получить OK).
 */

import { signCallback, buildCallbackAck } from '@/lib/payments/paykeeper/token';
import type { PaykeeperCallbackParams } from '@/lib/payments/paykeeper/types';

const SECRET = 'svc-secret';

// --- Мок репозитория (без БД). ---
const recordWebhookEventMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ inserted: true, processed: true }),
);
const setPaymentRefAndProviderMock = vi.fn((..._a: unknown[]) => Promise.resolve());
const findOrderIdByInvoiceIdMock = vi.fn((..._a: unknown[]) => Promise.resolve<string | null>(null));
// Серверный grand_total для сверки суммы колбэка (anti-tamper). По умолчанию совпадает
// с callback.sum ('1500.00'), чтобы happy-path handleCallback доходил до paid.
const getOrderGrandTotalByIdMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve<string | null>('1500.00'),
);

vi.mock('@/lib/payments/paykeeper/repository', () => ({
  recordWebhookEvent: (...a: unknown[]) => recordWebhookEventMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefAndProviderMock(...a),
  findOrderIdByInvoiceId: (...a: unknown[]) => findOrderIdByInvoiceIdMock(...a),
  getOrderGrandTotalById: (...a: unknown[]) => getOrderGrandTotalByIdMock(...a),
}));

const getOrderByNumberMock = vi.fn();
vi.mock('@/lib/orders/repository', () => ({
  getOrderByNumber: (...a: unknown[]) => getOrderByNumberMock(...a),
}));

import { PaykeeperManager } from '@/lib/payments/paykeeper/manager';
import { getPaykeeperConfig } from '@/lib/payments/paykeeper/config';
import { PaymentService } from '@/lib/payments/paykeeper/service';
import { PaykeeperError } from '@/lib/payments/paykeeper/errors';

const MOCK_CFG = getPaykeeperConfig({ NODE_ENV: 'test', PAYKEEPER_SECRET: SECRET });
const LIVE_CFG = getPaykeeperConfig({
  NODE_ENV: 'test',
  PAYKEEPER_LOGIN: 'l',
  PAYKEEPER_PASSWORD: 'p',
  PAYKEEPER_SECRET: SECRET,
});

function mockService(): PaymentService {
  return new PaymentService(new PaykeeperManager({ config: MOCK_CFG }));
}
function liveService(): PaymentService {
  // fetch не дёргается в handleCallback (нет сети), но нужен для конструктора client.
  return new PaymentService(
    new PaykeeperManager({ config: LIVE_CFG, fetchImpl: vi.fn() as unknown as typeof fetch }),
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

function callback(over: Partial<PaykeeperCallbackParams> = {}): PaykeeperCallbackParams {
  const base: PaykeeperCallbackParams = {
    id: '778899',
    sum: '1500.00',
    clientid: 'buyer@example.com',
    orderid: 'ADMIK-2026-000042',
    key: '',
  };
  const merged = { ...base, ...over };
  merged.key = over.key ?? signCallback(merged, SECRET);
  return merged;
}

beforeEach(() => {
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue({ inserted: true, processed: true });
  setPaymentRefAndProviderMock.mockReset();
  setPaymentRefAndProviderMock.mockResolvedValue(undefined);
  findOrderIdByInvoiceIdMock.mockReset();
  findOrderIdByInvoiceIdMock.mockResolvedValue(null);
  getOrderGrandTotalByIdMock.mockReset();
  getOrderGrandTotalByIdMock.mockResolvedValue('1500.00');
  getOrderByNumberMock.mockReset();
  getOrderByNumberMock.mockResolvedValue({ order: { id: 'order-uuid-1' }, items: [] });
});

describe('paykeeper/service — initPayment (mock)', () => {
  it('pay_amount В РУБЛЯХ (normalizeMoney), invoice сохранён, isMock', async () => {
    const res = await mockService().initPayment(fakeOrder() as never, []);
    expect(res.isMock).toBe(true);
    expect(res.invoiceId).toMatch(/^mock-inv-/);
    // demo-URL несёт amount в рублях (десятичная строка), не копейки.
    const amount = new URL(res.paymentUrl, 'http://x').searchParams.get('amount');
    expect(amount).toBe('1500.00');
    expect(setPaymentRefAndProviderMock).toHaveBeenCalledWith('order-uuid-1', res.invoiceId);
  });

  it('гард: отменённый заказ нельзя оплатить → PaykeeperError', async () => {
    await expect(
      mockService().initPayment(fakeOrder({ status: 'cancelled' }) as never, []),
    ).rejects.toBeInstanceOf(PaykeeperError);
    expect(setPaymentRefAndProviderMock).not.toHaveBeenCalled();
  });

  it('гард: уже оплаченный платёж нельзя переоплатить → PaykeeperError', async () => {
    await expect(
      mockService().initPayment(fakeOrder({ paymentStatus: 'paid' }) as never, []),
    ).rejects.toBeInstanceOf(PaykeeperError);
  });

  it('нулевая сумма → PaykeeperError', async () => {
    await expect(
      mockService().initPayment(fakeOrder({ grandTotal: '0.00' }) as never, []),
    ).rejects.toBeInstanceOf(PaykeeperError);
  });
});

describe('paykeeper/service — handleCallback', () => {
  it('валидная подпись, заказ по invoice_id → recordWebhookEvent(paid), ack корректный', async () => {
    findOrderIdByInvoiceIdMock.mockResolvedValue('order-uuid-1');
    const cb = callback();
    const res = await liveService().handleCallback(cb);
    expect(res.verified).toBe(true);
    expect(res.processed).toBe(true);
    expect(res.paymentStatus).toBe('paid');
    expect(res.ack).toBe(buildCallbackAck(cb.id, SECRET));
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { nextStatus: string; log: { status: string } };
    expect(arg.nextStatus).toBe('paid');
    expect(arg.log.status).toBe('PAID');
  });

  it('невалидная подпись → verified:false, ack:null, recordWebhookEvent НЕ вызвана', async () => {
    const res = await liveService().handleCallback(callback({ key: 'deadbeef' }));
    expect(res.verified).toBe(false);
    expect(res.ack).toBeNull();
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });

  it('фолбэк: заказ по orders.number=orderid, когда payment_ref не найден', async () => {
    findOrderIdByInvoiceIdMock.mockResolvedValue(null);
    getOrderByNumberMock.mockResolvedValue({ order: { id: 'order-by-number' }, items: [] });
    const res = await liveService().handleCallback(callback());
    expect(res.verified).toBe(true);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { log: { orderId: string } };
    expect(arg.log.orderId).toBe('order-by-number');
  });

  it('дубликат (recordWebhookEvent inserted:false) → duplicate:true, ack есть', async () => {
    findOrderIdByInvoiceIdMock.mockResolvedValue('order-uuid-1');
    recordWebhookEventMock.mockResolvedValue({ inserted: false, processed: false });
    const cb = callback();
    const res = await liveService().handleCallback(cb);
    expect(res.duplicate).toBe(true);
    expect(res.processed).toBe(false);
    expect(res.ack).toBe(buildCallbackAck(cb.id, SECRET));
  });

  it('заказ не найден, но подпись валидна → verified:true, ack есть (PayKeeper получит OK)', async () => {
    findOrderIdByInvoiceIdMock.mockResolvedValue(null);
    getOrderByNumberMock.mockResolvedValue(null);
    const cb = callback();
    const res = await liveService().handleCallback(cb);
    expect(res.verified).toBe(true);
    expect(res.processed).toBe(false);
    expect(res.ack).toBe(buildCallbackAck(cb.id, SECRET));
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });

  it('СВЕРКА СУММЫ: sum != серверный grand_total → НЕ paid, лог AMOUNT_MISMATCH, ack есть', async () => {
    // Колбэк с валидной подписью, но сумма (10.00) не совпадает с grand_total (1500.00).
    findOrderIdByInvoiceIdMock.mockResolvedValue('order-uuid-1');
    getOrderGrandTotalByIdMock.mockResolvedValue('1500.00');
    const cb = callback({ sum: '10.00' }); // подпись пересчитается под sum=10.00
    const res = await liveService().handleCallback(cb);
    // Подпись валидна → ack есть (PayKeeper получит OK, не ретраит).
    expect(res.verified).toBe(true);
    expect(res.ack).toBe(buildCallbackAck(cb.id, SECRET));
    // Заказ НЕ помечен paid.
    expect(res.processed).toBe(false);
    expect(res.paymentStatus).toBeNull();
    expect(res.amountMismatch).toBe(true);
    // Событие записано для РУЧНОЙ сверки: status 'AMOUNT_MISMATCH', переход НЕ применяется.
    const arg = recordWebhookEventMock.mock.calls[0]![0] as {
      nextStatus: string | null;
      log: { status: string; rawPayload: { reason: string; expectedKop: number; paidKop: number } };
    };
    expect(arg.log.status).toBe('AMOUNT_MISMATCH');
    expect(arg.nextStatus).toBeNull();
    expect(arg.log.rawPayload).toMatchObject({ reason: 'amount_mismatch', expectedKop: 150000, paidKop: 1000 });
  });

  it('СВЕРКА СУММЫ: grand_total недоступен (null) → fail-safe, НЕ paid, reason grand_total_unavailable', async () => {
    // Заказ резолвнут, но grand_total не получен (напр. TOCTOU-окно) → не можем сверить →
    // НЕ метим paid (fail-safe), а не «пропускаем проверку».
    findOrderIdByInvoiceIdMock.mockResolvedValue('order-uuid-1');
    getOrderGrandTotalByIdMock.mockResolvedValue(null);
    const cb = callback({ sum: '1500.00' }); // сумма любая — всё равно не с чем сверять
    const res = await liveService().handleCallback(cb);
    expect(res.verified).toBe(true);
    expect(res.ack).toBe(buildCallbackAck(cb.id, SECRET));
    expect(res.processed).toBe(false);
    expect(res.paymentStatus).toBeNull();
    expect(res.amountMismatch).toBe(true);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as {
      nextStatus: string | null;
      log: { status: string; rawPayload: { reason: string; expectedKop: number | null } };
    };
    expect(arg.log.status).toBe('AMOUNT_MISMATCH');
    expect(arg.nextStatus).toBeNull();
    expect(arg.log.rawPayload).toMatchObject({ reason: 'grand_total_unavailable', expectedKop: null });
  });

  it('СВЕРКА СУММЫ: точное совпадение sum == grand_total → paid как обычно', async () => {
    findOrderIdByInvoiceIdMock.mockResolvedValue('order-uuid-1');
    getOrderGrandTotalByIdMock.mockResolvedValue('1500.00');
    const cb = callback({ sum: '1500.00' });
    const res = await liveService().handleCallback(cb);
    expect(res.amountMismatch).toBeUndefined();
    expect(res.processed).toBe(true);
    expect(res.paymentStatus).toBe('paid');
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { nextStatus: string; log: { status: string } };
    expect(arg.nextStatus).toBe('paid');
    expect(arg.log.status).toBe('PAID');
  });

  it('без secret в конфиге → verified:false (verify невозможен)', async () => {
    const noSecret = getPaykeeperConfig({ NODE_ENV: 'test', PAYKEEPER_LOGIN: 'l', PAYKEEPER_PASSWORD: 'p' });
    const svc = new PaymentService(
      new PaykeeperManager({ config: noSecret, fetchImpl: vi.fn() as unknown as typeof fetch }),
    );
    const res = await svc.handleCallback(callback());
    expect(res.verified).toBe(false);
    expect(res.ack).toBeNull();
  });
});

describe('paykeeper/service — reconcile / refund / confirmMock', () => {
  it('reconcilePayment (mock): статус paid → applied', async () => {
    const res = await mockService().reconcilePayment({
      orderId: 'order-uuid-1',
      orderNumber: 'ADMIK-2026-000042',
      invoiceId: 'mock-inv-1',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('paid');
  });

  it('refundPayment — MVP всегда skipped:manual (reverse не реализован)', async () => {
    const res = await mockService().refundPayment({
      orderId: 'o',
      orderNumber: 'n',
      paymentStatus: 'paid',
      paymentProvider: 'paykeeper',
      paymentRef: '778899',
      amountKop: 150000,
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('manual');
  });

  it('confirmMockPayment: несовпадение payment_ref → refuse', async () => {
    getOrderByNumberMock.mockResolvedValue({
      order: { id: 'order-uuid-1', paymentRef: 'other-inv', grandTotal: '1500.00' },
      items: [],
    });
    const res = await mockService().confirmMockPayment('ADMIK-2026-000042', 'mock-inv-1');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('payment_ref_mismatch');
  });

  it('confirmMockPayment: совпадение payment_ref → ok + recordWebhookEvent(PAID)', async () => {
    getOrderByNumberMock.mockResolvedValue({
      order: { id: 'order-uuid-1', paymentRef: 'mock-inv-1', grandTotal: '1500.00' },
      items: [],
    });
    const res = await mockService().confirmMockPayment('ADMIK-2026-000042', 'mock-inv-1');
    expect(res.ok).toBe(true);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { log: { status: string } };
    expect(arg.log.status).toBe('PAID');
  });
});
