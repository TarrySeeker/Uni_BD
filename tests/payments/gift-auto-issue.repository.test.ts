import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * recordWebhookEvent всех трёх провайдеров ДОЛЖЕН отдавать наружу результат
 * перехода payment_status: { inserted, processed, applied, paymentStatus }.
 * Раньше boolean из applyPaymentStatusTx терялся внутри транзакции, и вызывающий
 * не мог отличить «заказ реально стал paid этим событием» от «событие записано,
 * но переход не применён» — а именно на этом отличии стоит автовыпуск
 * подарочных сертификатов (ТЗ п.11). Сам вызов автовыпуска в транзакции
 * ЗАПРЕЩЁН (см. gift-auto-issue.guard.test.ts).
 *
 * sql замокан (без БД), как в tests/payments/paykeeper/repository.test.ts.
 */

const h = vi.hoisted(() => {
  const state = {
    selectStatus: 'pending' as string | null,
    selectOrderStatus: 'awaiting_payment' as string,
    updateCount: 1,
    logInsertId: 'log-1' as string | null,
  };

  const txTag = vi.fn((strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join('?').trim();
    if (/^SELECT/i.test(text)) {
      return Promise.resolve(
        state.selectStatus === null
          ? []
          : [{ payment_status: state.selectStatus, status: state.selectOrderStatus }],
      );
    }
    if (/^INSERT/i.test(text) && /_payment_log/i.test(text)) {
      return Promise.resolve(state.logInsertId === null ? [] : [{ id: state.logInsertId }]);
    }
    if (/^UPDATE/i.test(text) && /_payment_log/i.test(text)) return Promise.resolve([]);
    if (/^UPDATE/i.test(text)) {
      const arr: unknown[] = [];
      (arr as unknown as { count: number }).count = state.updateCount;
      return Promise.resolve(arr);
    }
    return Promise.resolve([]);
  });

  const sqlFn = vi.fn(() => Promise.resolve([])) as unknown as {
    (...a: unknown[]): Promise<unknown>;
    begin: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  sqlFn.begin = vi.fn(async (cb: (tx: unknown) => unknown) => cb(txTag));
  sqlFn.json = vi.fn((v: unknown) => v);

  return { state, sqlFn };
});

vi.mock('@/lib/db/client', () => ({ sql: h.sqlFn }));

import { recordWebhookEvent as tbankRecord } from '@/lib/payments/tbank/repository';
import { recordWebhookEvent as paykeeperRecord } from '@/lib/payments/paykeeper/repository';
import { recordWebhookEvent as alfabankRecord } from '@/lib/payments/alfabank/repository';

const { state } = h;

const CALLS = [
  {
    provider: 'tbank',
    call: (nextStatus: 'paid' | 'failed' | null) =>
      tbankRecord({
        log: { orderId: 'order-1', paymentId: 'pay-1', status: 'CONFIRMED' },
        nextStatus,
        comment: 'test',
      }),
  },
  {
    provider: 'paykeeper',
    call: (nextStatus: 'paid' | 'failed' | null) =>
      paykeeperRecord({
        log: { orderId: 'order-1', invoiceId: 'inv-1', status: 'PAID' },
        nextStatus,
        comment: 'test',
      }),
  },
  {
    provider: 'alfabank',
    call: (nextStatus: 'paid' | 'failed' | null) =>
      alfabankRecord({
        log: { orderId: 'order-1', orderRef: 'ref-1', status: 'deposited:1' },
        nextStatus,
        comment: 'test',
      }),
  },
] as const;

beforeEach(() => {
  state.selectStatus = 'pending';
  state.selectOrderStatus = 'awaiting_payment';
  state.updateCount = 1;
  state.logInsertId = 'log-1';
});

describe.each(CALLS)('$provider/recordWebhookEvent — результат перехода наружу', ({ call }) => {
  it('новое событие + переход применён → applied:true, paymentStatus:paid', async () => {
    const res = await call('paid');
    expect(res).toMatchObject({
      inserted: true,
      processed: true,
      applied: true,
      paymentStatus: 'paid',
    });
  });

  it('переход НЕ применён (недопустим из текущего статуса) → applied:false, paymentStatus:null', async () => {
    state.selectStatus = 'paid';
    const res = await call('paid');
    expect(res).toMatchObject({ inserted: true, applied: false, paymentStatus: null });
  });

  it('nextStatus=null (нет маппинга) → applied:false, paymentStatus:null', async () => {
    const res = await call(null);
    expect(res).toMatchObject({ inserted: true, applied: false, paymentStatus: null });
  });

  it('дубликат события (ON CONFLICT DO NOTHING) → inserted:false, applied:false', async () => {
    state.logInsertId = null;
    const res = await call('paid');
    expect(res).toMatchObject({ inserted: false, applied: false, paymentStatus: null });
  });

  it('не-paid переход (failed) → applied:true, но paymentStatus не paid', async () => {
    const res = await call('failed');
    expect(res.applied).toBe(true);
    expect(res.paymentStatus).toBe('failed');
  });
});
