import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ПОВЕДЕНЧЕСКИЕ тесты пост-коммитного автовыпуска сертификатов (ТЗ п.11) во всех
 * трёх провайдерах. БД и orders-репозиторий замоканы.
 *
 * Главное, что проверяется:
 *   • автовыпуск БРОСИЛ → факт оплаты НЕ пострадал: recordWebhookEvent вызван и
 *     завершён (лог + переход + processed уже закоммичены), ответ провайдеру
 *     успешный (verified/processed/ack), исключение наружу НЕ вышло;
 *   • повторная доставка события (inserted:false) → автовыпуск НЕ вызывается;
 *   • событие записано, но переход не применён (applied:false) или статус не paid
 *     → автовыпуск НЕ вызывается;
 *   • paid → автовыпуск вызван РОВНО ОДИН раз и именно с id заказа;
 *   • вызов идёт ПОСЛЕ recordWebhookEvent (порядок фиксируется по журналу вызовов).
 */

const ORDER_ID = 'order-uuid-1';
const SECRET = 'gift-hook-secret';

const calls: string[] = [];

// --- Автовыпуск (единственный общий мок на все три провайдера). ---
const autoIssueMock = vi.fn(async (..._a: unknown[]) => {
  calls.push('autoIssue');
  return { orderId: ORDER_ID, ok: true, issued: 1, skipped: 0, failed: 0, items: [] };
});
vi.mock('@/lib/gift-certificates/auto-issue', () => ({
  autoIssueGiftsForPaidOrder: (...a: unknown[]) => autoIssueMock(...a),
}));

// --- Репозитории провайдеров (без БД). ---
interface RecordResult {
  inserted: boolean;
  processed: boolean;
  applied: boolean;
  paymentStatus: string | null;
}

const recordMock = vi.fn(async (..._a: unknown[]): Promise<RecordResult> => {
  calls.push('record');
  return { inserted: true, processed: true, applied: true, paymentStatus: 'paid' };
});
const noop = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock('@/lib/payments/tbank/repository', () => ({
  recordWebhookEvent: (...a: unknown[]) => recordMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => noop(...a),
  insertPaymentLog: async () => ({ inserted: true, id: 'log-1' }),
}));
vi.mock('@/lib/payments/paykeeper/repository', () => ({
  recordWebhookEvent: (...a: unknown[]) => recordMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => noop(...a),
  findOrderIdByInvoiceId: async () => ORDER_ID,
  getOrderGrandTotalById: async () => '1500.00',
}));
vi.mock('@/lib/payments/alfabank/repository', () => ({
  recordWebhookEvent: (...a: unknown[]) => recordMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => noop(...a),
  findOrderIdByRef: async () => ORDER_ID,
  insertPaymentLog: async () => ({ inserted: true, id: 'log-1' }),
}));

const getOrderByNumberMock = vi.fn();
vi.mock('@/lib/orders/repository', () => ({
  getOrderByNumber: (...a: unknown[]) => getOrderByNumberMock(...a),
}));

import { signToken } from '@/lib/payments/tbank/token';
import { signCallback as signPaykeeper } from '@/lib/payments/paykeeper/token';
import { signCallback as signAlfabank } from '@/lib/payments/alfabank/token';
import { TbankManager } from '@/lib/payments/tbank/manager';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import { PaymentService as TbankService } from '@/lib/payments/tbank/service';
import { PaykeeperManager } from '@/lib/payments/paykeeper/manager';
import { getPaykeeperConfig } from '@/lib/payments/paykeeper/config';
import { PaymentService as PaykeeperService } from '@/lib/payments/paykeeper/service';
import { AlfabankManager } from '@/lib/payments/alfabank/manager';
import { getAlfabankConfig } from '@/lib/payments/alfabank/config';
import { PaymentService as AlfabankService } from '@/lib/payments/alfabank/service';
import type { AlfabankCallbackParams } from '@/lib/payments/alfabank/types';
import type { PaykeeperCallbackParams } from '@/lib/payments/paykeeper/types';

/** Успешный ответ провайдеру (то, что роут отдаёт банку) для каждого провайдера. */
interface ProviderCase {
  provider: string;
  /** Обработать успешное «оплачено» событие. */
  handle: () => Promise<Record<string, unknown>>;
  /** Признак «ответ провайдеру успешный». */
  expectOk: (res: Record<string, unknown>) => void;
}

function tbankCase(): ProviderCase {
  const cfg = getTbankConfig({
    NODE_ENV: 'test',
    TBANK_TERMINAL_KEY: 'tk',
    TBANK_PASSWORD: SECRET,
  });
  const svc = new TbankService(new TbankManager({ config: cfg }));
  const body: Record<string, unknown> = {
    TerminalKey: 'tk',
    OrderId: 'ADMIK-2026-000042',
    Success: true,
    PaymentId: '900000001',
    Amount: 150000,
    Status: 'CONFIRMED',
  };
  body.Token = signToken(body, SECRET);
  return {
    provider: 'tbank',
    handle: () => svc.handleWebhook(body) as unknown as Promise<Record<string, unknown>>,
    expectOk: (res) => {
      expect(res.verified).toBe(true);
      expect(res.processed).toBe(true);
    },
  };
}

function paykeeperCase(): ProviderCase {
  const cfg = getPaykeeperConfig({
    NODE_ENV: 'test',
    PAYKEEPER_LOGIN: 'l',
    PAYKEEPER_PASSWORD: 'p',
    PAYKEEPER_SECRET: SECRET,
  });
  const svc = new PaykeeperService(
    new PaykeeperManager({ config: cfg, fetchImpl: vi.fn() as unknown as typeof fetch }),
  );
  const params: PaykeeperCallbackParams = {
    id: 'inv-1',
    sum: '1500.00',
    clientid: 'Buyer',
    orderid: 'ADMIK-2026-000042',
    key: '',
  };
  params.key = signPaykeeper(params, SECRET);
  return {
    provider: 'paykeeper',
    handle: () => svc.handleCallback(params) as unknown as Promise<Record<string, unknown>>,
    expectOk: (res) => {
      expect(res.verified).toBe(true);
      expect(res.processed).toBe(true);
      // PayKeeper обязан получить ack, иначе ретраит до 50 раз.
      expect(res.ack).toBeTruthy();
    },
  };
}

function alfabankCase(): ProviderCase {
  const cfg = getAlfabankConfig({
    NODE_ENV: 'test',
    ALFABANK_USERNAME: 'u',
    ALFABANK_PASSWORD: 'p',
    ALFABANK_CALLBACK_SECRET: SECRET,
  });
  const svc = new AlfabankService(
    new AlfabankManager({ config: cfg, fetchImpl: vi.fn() as unknown as typeof fetch }),
  );
  const params: AlfabankCallbackParams = {
    mdOrder: 'alfa-778899',
    orderNumber: 'ADMIK-2026-000042',
    operation: 'deposited',
    status: '1',
    checksum: '',
    rest: {},
  };
  params.checksum = signAlfabank(
    {
      mdOrder: params.mdOrder,
      orderNumber: params.orderNumber,
      operation: params.operation,
      status: params.status,
    },
    SECRET,
  );
  return {
    provider: 'alfabank',
    handle: () => svc.handleCallback(params) as unknown as Promise<Record<string, unknown>>,
    expectOk: (res) => {
      expect(res.verified).toBe(true);
      expect(res.processed).toBe(true);
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  recordMock.mockClear();
  recordMock.mockImplementation(async (): Promise<RecordResult> => {
    calls.push('record');
    return { inserted: true, processed: true, applied: true, paymentStatus: 'paid' };
  });
  autoIssueMock.mockClear();
  autoIssueMock.mockImplementation(async () => {
    calls.push('autoIssue');
    return { orderId: ORDER_ID, ok: true, issued: 1, skipped: 0, failed: 0, items: [] };
  });
  getOrderByNumberMock.mockReset();
  getOrderByNumberMock.mockResolvedValue({
    order: { id: ORDER_ID, number: 'ADMIK-2026-000042', grandTotal: '1500.00', paymentRef: null },
    items: [],
  });
});

describe.each([tbankCase, paykeeperCase, alfabankCase].map((f) => [f().provider, f] as const))(
  'payments/%s — автовыпуск сертификатов после коммита оплаты',
  (_name, factory) => {
    it('оплата зафиксирована (paid) → автовыпуск вызван один раз, ПОСЛЕ recordWebhookEvent', async () => {
      const c = factory();
      const res = await c.handle();
      c.expectOk(res);
      expect(autoIssueMock).toHaveBeenCalledTimes(1);
      expect(autoIssueMock).toHaveBeenCalledWith(ORDER_ID);
      expect(calls).toEqual(['record', 'autoIssue']);
    });

    it('🔴 автовыпуск БРОСИЛ → оплата не откатывается, ответ провайдеру успешный', async () => {
      const c = factory();
      autoIssueMock.mockImplementation(async () => {
        calls.push('autoIssue');
        throw new Error('boom: выпуск сертификата упал');
      });
      const res = await c.handle();
      // Исключение не вышло наружу (иначе роут отдал бы 500 и банк ретраил бы).
      c.expectOk(res);
      // Фиксация оплаты произошла ДО автовыпуска и в своей транзакции — откатить
      // её падение выпуска не может.
      expect(recordMock).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['record', 'autoIssue']);
    });

    it('повторная доставка события (inserted:false) → автовыпуск НЕ вызывается', async () => {
      const c = factory();
      recordMock.mockImplementation(async (): Promise<RecordResult> => {
        calls.push('record');
        return { inserted: false, processed: false, applied: false, paymentStatus: null };
      });
      await c.handle();
      expect(autoIssueMock).not.toHaveBeenCalled();
    });

    it('переход не применён (applied:false) → автовыпуск НЕ вызывается', async () => {
      const c = factory();
      recordMock.mockImplementation(async (): Promise<RecordResult> => {
        calls.push('record');
        return { inserted: true, processed: false, applied: false, paymentStatus: null };
      });
      await c.handle();
      expect(autoIssueMock).not.toHaveBeenCalled();
    });

    it('переход в НЕ-paid статус (failed/refunded) → автовыпуск НЕ вызывается', async () => {
      const c = factory();
      recordMock.mockImplementation(async (): Promise<RecordResult> => {
        calls.push('record');
        return { inserted: true, processed: true, applied: true, paymentStatus: 'refunded' };
      });
      await c.handle();
      expect(autoIssueMock).not.toHaveBeenCalled();
    });
  },
);

describe('mock-подтверждение оплаты на стенде (confirmMockPayment) тоже выпускает сертификат', () => {
  it('tbank confirmMockPayment → автовыпуск вызван', async () => {
    getOrderByNumberMock.mockResolvedValue({
      order: {
        id: ORDER_ID,
        number: 'ADMIK-2026-000042',
        grandTotal: '1500.00',
        paymentRef: 'mock-pay-1',
      },
      items: [],
    });
    const svc = new TbankService(new TbankManager({ config: getTbankConfig({ NODE_ENV: 'test' }) }));
    const res = await svc.confirmMockPayment('ADMIK-2026-000042', 'mock-pay-1');
    expect(res.ok).toBe(true);
    expect(autoIssueMock).toHaveBeenCalledWith(ORDER_ID);
    expect(calls).toEqual(['record', 'autoIssue']);
  });

  it('paykeeper confirmMockPayment → автовыпуск вызван', async () => {
    getOrderByNumberMock.mockResolvedValue({
      order: {
        id: ORDER_ID,
        number: 'ADMIK-2026-000042',
        grandTotal: '1500.00',
        paymentRef: 'mock-inv-1',
      },
      items: [],
    });
    const svc = new PaykeeperService(
      new PaykeeperManager({ config: getPaykeeperConfig({ NODE_ENV: 'test' }) }),
    );
    const res = await svc.confirmMockPayment('ADMIK-2026-000042', 'mock-inv-1');
    expect(res.ok).toBe(true);
    expect(autoIssueMock).toHaveBeenCalledWith(ORDER_ID);
  });

  it('alfabank confirmMockPayment → автовыпуск вызван', async () => {
    getOrderByNumberMock.mockResolvedValue({
      order: {
        id: ORDER_ID,
        number: 'ADMIK-2026-000042',
        grandTotal: '1500.00',
        paymentRef: 'mock-alfa-1',
      },
      items: [],
    });
    const svc = new AlfabankService(
      new AlfabankManager({ config: getAlfabankConfig({ NODE_ENV: 'test' }) }),
    );
    const res = await svc.confirmMockPayment('ADMIK-2026-000042', 'mock-alfa-1');
    expect(res.ok).toBe(true);
    expect(autoIssueMock).toHaveBeenCalledWith(ORDER_ID);
  });
});

describe('сверка потерянного платежа (reconcilePayment) тоже выпускает сертификат', () => {
  it('tbank reconcilePayment (mock, CONFIRMED) → автовыпуск вызван', async () => {
    const svc = new TbankService(new TbankManager({ config: getTbankConfig({ NODE_ENV: 'test' }) }));
    const res = await svc.reconcilePayment({
      orderId: ORDER_ID,
      orderNumber: 'ADMIK-2026-000042',
      paymentId: 'mock-pay-1',
      amountKop: 150000,
    });
    expect(res.ok).toBe(true);
    expect(autoIssueMock).toHaveBeenCalledWith(ORDER_ID);
    expect(calls).toEqual(['record', 'autoIssue']);
  });
});
