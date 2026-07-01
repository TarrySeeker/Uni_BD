import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Юнит-тесты PaymentService.reconcilePayment (Фича #16, GetState-сверка) и
 * PaymentService.refundPayment (Фича #15, Cancel-возврат). БД-репозиторий замокан
 * (recordWebhookEvent / insertPaymentLog) — проверяем связку «решение по статусу +
 * вызов шлюза/mock + запись лога» БЕЗ живой БД и сети (как webhook.test.ts).
 *
 * КЛЮЧЕВОЙ ИНВАРИАНТ refundPayment: метод ТОЛЬКО дёргает шлюз и пишет аудит-лог
 * (insertPaymentLog) — payment_status он НЕ меняет (это делает внутренний сетл
 * applyOrderStatusTransition в экшене). Поэтому recordWebhookEvent тут НЕ зовётся.
 */

const recordWebhookEventMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ inserted: true, processed: true }),
);
const insertPaymentLogMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ inserted: true, id: 'log-1' }),
);
const setPaymentRefAndProviderMock = vi.fn((..._a: unknown[]) => Promise.resolve());

vi.mock('@/lib/payments/tbank/repository', () => ({
  recordWebhookEvent: (...a: unknown[]) => recordWebhookEventMock(...a),
  insertPaymentLog: (...a: unknown[]) => insertPaymentLogMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefAndProviderMock(...a),
}));

import { TbankManager } from '@/lib/payments/tbank/manager';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import { PaymentService } from '@/lib/payments/tbank/service';
import type {
  TbankGetStateResponse,
  TbankCancelResponse,
} from '@/lib/payments/tbank/types';

// MOCK-режим: боевые ключи не заданы → isMock=true, доступны manager.mock.*.
const CFG_MOCK = getTbankConfig({ NODE_ENV: 'test' });
// БОЕВОЙ режим: ключи заданы → isMock=false, manager.client доступен.
const CFG_REAL = getTbankConfig({
  NODE_ENV: 'test',
  TBANK_TERMINAL_KEY: 'tk',
  TBANK_PASSWORD: 'pw',
});

function mockService(): PaymentService {
  return new PaymentService(new TbankManager({ config: CFG_MOCK }));
}

/**
 * Боевой менеджер с подменённым client.call (без сети). callResult — что вернёт
 * шлюз на любой вызов (GetState/Cancel). isMock=false.
 */
function realService(callResult: unknown): {
  service: PaymentService;
  call: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn(async () => callResult);
  const manager = {
    isMock: false,
    config: CFG_REAL,
    mock: new TbankManager({ config: CFG_MOCK }).mock,
    client: { call },
  } as unknown as TbankManager;
  return { service: new PaymentService(manager), call };
}

beforeEach(() => {
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue({ inserted: true, processed: true });
  insertPaymentLogMock.mockReset();
  insertPaymentLogMock.mockResolvedValue({ inserted: true, id: 'log-1' });
});

// =============================================================================
// reconcilePayment (Фича #16 — GetState).
// =============================================================================

describe('PaymentService.reconcilePayment (GetState-сверка)', () => {
  it('mock: GetState=CONFIRMED → next=paid, applied=true, isMock=true', async () => {
    const r = await mockService().reconcilePayment({
      orderId: 'o-1',
      orderNumber: 'GA-2026-000001',
      paymentId: 'mock-pay-900000001',
      amountKop: 150000,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('CONFIRMED');
    expect(r.applied).toBe(true);
    expect(r.isMock).toBe(true);
    expect(recordWebhookEventMock).toHaveBeenCalledTimes(1);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as {
      log: { orderId: string; paymentId: string; isMock: boolean; amountKop: number | null };
      nextStatus: string | null;
      comment: string;
    };
    expect(arg.nextStatus).toBe('paid');
    expect(arg.comment).toBe('reconcile-getstate:CONFIRMED');
    expect(arg.log.orderId).toBe('o-1');
    expect(arg.log.paymentId).toBe('mock-pay-900000001');
    expect(arg.log.amountKop).toBe(150000);
    expect(arg.log.isMock).toBe(true);
  });

  it('идемпотентность: повторная сверка не задваивает (recordWebhookEvent дубликат → applied=false)', async () => {
    recordWebhookEventMock.mockResolvedValueOnce({ inserted: true, processed: true });
    const r1 = await mockService().reconcilePayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentId: 'P1',
    });
    expect(r1.applied).toBe(true);

    recordWebhookEventMock.mockResolvedValueOnce({ inserted: false, processed: false });
    const r2 = await mockService().reconcilePayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentId: 'P1',
    });
    expect(r2.ok).toBe(true);
    expect(r2.applied).toBe(false);
    expect(recordWebhookEventMock).toHaveBeenCalledTimes(2);
  });

  it('real: GetState успех (CONFIRMED) → applied, client.call(GetState) вызван', async () => {
    const { service, call } = realService({
      Success: true,
      ErrorCode: '0',
      Status: 'CONFIRMED',
    } as TbankGetStateResponse);
    const r = await service.reconcilePayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentId: 'P1',
      amountKop: 1000,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('CONFIRMED');
    expect(r.isMock).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toBe('GetState');
    const body = call.mock.calls[0]![1] as { TerminalKey: string; PaymentId: string };
    expect(body.PaymentId).toBe('P1');
    expect(body.TerminalKey).toBe('tk');
  });

  it('real: GetState !Success → ok=false, applied=false, recordWebhookEvent НЕ вызван', async () => {
    const { service } = realService({
      Success: false,
      ErrorCode: '204',
      Message: 'not found',
    } as TbankGetStateResponse);
    const r = await service.reconcilePayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentId: 'P1',
    });
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.status).toBeNull();
    expect(r.reason).toBe('204');
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// refundPayment (Фича #15 — Cancel).
// =============================================================================

describe('PaymentService.refundPayment (Cancel-возврат)', () => {
  it('provider!=="tbank" → skipped no_gateway, лог НЕ пишется', async () => {
    const r = await mockService().refundPayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentStatus: 'paid',
      paymentProvider: 'manual',
      paymentRef: 'P1',
      amountKop: 100,
    });
    expect(r).toMatchObject({ ok: true, skipped: true, status: null, reason: 'no_gateway' });
    expect(insertPaymentLogMock).not.toHaveBeenCalled();
  });

  it('paymentRef отсутствует → skipped no_gateway', async () => {
    const r = await mockService().refundPayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentStatus: 'paid',
      paymentProvider: 'tbank',
      paymentRef: null,
      amountKop: 100,
    });
    expect(r).toMatchObject({ ok: true, skipped: true, reason: 'no_gateway' });
    expect(insertPaymentLogMock).not.toHaveBeenCalled();
  });

  it('paymentStatus="pending" → skipped not_captured (нечего возвращать)', async () => {
    const r = await mockService().refundPayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentStatus: 'pending',
      paymentProvider: 'tbank',
      paymentRef: 'P1',
      amountKop: 100,
    });
    expect(r).toMatchObject({ ok: true, skipped: true, reason: 'not_captured' });
    expect(insertPaymentLogMock).not.toHaveBeenCalled();
  });

  it('mock: tbank+paid → status=REFUNDED, insertPaymentLog вызван, payment_status НЕ меняется (recordWebhookEvent не зовётся)', async () => {
    const r = await mockService().refundPayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentStatus: 'paid',
      paymentProvider: 'tbank',
      paymentRef: 'P1',
      amountKop: 250000,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('REFUNDED');
    // Метод возвращает РЕАЛЬНЫЙ статус шлюза (для трассировки/аудита экшена).
    expect(r.status).toBe('REFUNDED');
    expect(r.isMock).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(insertPaymentLogMock).toHaveBeenCalledTimes(1);
    const arg = insertPaymentLogMock.mock.calls[0]![0] as {
      orderId: string;
      paymentId: string;
      status: string;
      amountKop: number;
      isMock: boolean;
      rawPayload: { source: string; gatewayStatus: string | null };
    };
    // ФИКС 2 (самозалечивание): аудит-строка пишется с СИНТЕТИЧЕСКИМ статусом
    // 'ADMIN_REFUND' — он НЕ коллизирует с реальным Т-Банк-статусом по UNIQUE
    // (payment_id, status), поэтому поздний настоящий REFUNDED-webhook не блокируется
    // и сможет довести payment_status='refunded'. Реальный статус — в rawPayload.gatewayStatus.
    expect(arg.status).toBe('ADMIN_REFUND');
    expect(arg.rawPayload.gatewayStatus).toBe('REFUNDED');
    expect(arg.paymentId).toBe('P1');
    expect(arg.amountKop).toBe(250000);
    // ИНВАРИАНТ: метод НЕ применяет переход payment_status сам.
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });

  it('mock: tbank+authorized → status=REVERSED (отмена холда до списания)', async () => {
    const r = await mockService().refundPayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentStatus: 'authorized',
      paymentProvider: 'tbank',
      paymentRef: 'P1',
      amountKop: 100,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('REVERSED');
    expect(insertPaymentLogMock).toHaveBeenCalledTimes(1);
  });

  it('real: Cancel успех → client.call(Cancel) вызван, лог записан', async () => {
    const { service, call } = realService({
      Success: true,
      ErrorCode: '0',
      Status: 'REFUNDED',
    } as TbankCancelResponse);
    const r = await service.refundPayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentStatus: 'paid',
      paymentProvider: 'tbank',
      paymentRef: 'P1',
      amountKop: 100,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('REFUNDED');
    expect(r.isMock).toBe(false);
    expect(call.mock.calls[0]![0]).toBe('Cancel');
    const body = call.mock.calls[0]![1] as { PaymentId: string };
    expect(body.PaymentId).toBe('P1');
    expect(insertPaymentLogMock).toHaveBeenCalledTimes(1);
  });

  it('real: Cancel !Success → ok=false, лог НЕ пишется', async () => {
    const { service } = realService({
      Success: false,
      ErrorCode: '9999',
      Message: 'cancel declined',
    } as TbankCancelResponse);
    const r = await service.refundPayment({
      orderId: 'o-1',
      orderNumber: 'N1',
      paymentStatus: 'paid',
      paymentProvider: 'tbank',
      paymentRef: 'P1',
      amountKop: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.reason).toBe('9999');
    expect(insertPaymentLogMock).not.toHaveBeenCalled();
  });
});
