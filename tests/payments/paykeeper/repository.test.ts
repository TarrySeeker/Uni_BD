import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты репозитория PayKeeper (docs/24 §2) — applyPaymentStatus / recordWebhookEvent
 * с ЗАМОКАННЫМ sql (без БД). Ключ идемпотентности — UNIQUE (invoice_id, status).
 *
 * КЛЮЧЕВОЕ:
 *   • recordWebhookEvent — запись лога + переход + пометка processed В ОДНОЙ
 *     транзакции (sql.begin); дубликат (ON CONFLICT → []) → без эффектов;
 *   • applyPaymentStatusTx — SELECT ... FOR UPDATE + guarded UPDATE + C4-1 гард.
 */

interface TxQueryLog {
  text: string;
}

const h = vi.hoisted(() => {
  const state = {
    selectStatus: 'pending' as string | null,
    selectOrderStatus: 'awaiting_payment' as string,
    updateCount: 1,
    logInsertId: 'log-1' as string | null,
    beginCalls: 0,
    queries: [] as TxQueryLog[],
  };

  const txTag = vi.fn((strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join('?').trim();
    state.queries.push({ text });
    if (/^SELECT/i.test(text)) {
      const rows =
        state.selectStatus === null
          ? []
          : [{ payment_status: state.selectStatus, status: state.selectOrderStatus }];
      return Promise.resolve(rows);
    }
    if (/^INSERT/i.test(text) && /paykeeper_payment_log/i.test(text)) {
      const rows = state.logInsertId === null ? [] : [{ id: state.logInsertId }];
      return Promise.resolve(rows);
    }
    if (/^UPDATE/i.test(text) && /paykeeper_payment_log/i.test(text)) {
      return Promise.resolve([]);
    }
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
  sqlFn.begin = vi.fn(async (cb: (tx: unknown) => unknown) => {
    state.beginCalls++;
    return cb(txTag);
  });
  sqlFn.json = vi.fn((v: unknown) => v);

  return { state, txTag, sqlFn };
});

vi.mock('@/lib/db/client', () => ({ sql: h.sqlFn }));

import { applyPaymentStatus, recordWebhookEvent } from '@/lib/payments/paykeeper/repository';

const { state } = h;

function reset(): void {
  state.selectStatus = 'pending';
  state.selectOrderStatus = 'awaiting_payment';
  state.updateCount = 1;
  state.logInsertId = 'log-1';
  state.beginCalls = 0;
  state.queries = [];
  h.txTag.mockClear();
  h.sqlFn.begin.mockClear();
}

beforeEach(reset);

describe('paykeeper/repository — applyPaymentStatus', () => {
  it('допустимый переход pending → paid применяется, paid_at + история', async () => {
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(true);
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text) && /orders/i.test(q.text));
    expect(upd!.text.toLowerCase()).toContain('paid_at');
    const hist = state.queries.find((q) => /order_status_history/i.test(q.text));
    expect(hist).toBeDefined();
  });

  it('SELECT ... FOR UPDATE внутри транзакции, guarded UPDATE по payment_status=from', async () => {
    await applyPaymentStatus('ord-1', 'paid');
    const select = state.queries.find((q) => /^SELECT/i.test(q.text));
    expect(select!.text.toUpperCase()).toContain('FOR UPDATE');
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text) && /orders/i.test(q.text));
    expect(upd!.text.toLowerCase()).toContain('and payment_status =');
  });

  it('C4-1: paid на ОТМЕНЁННОМ заказе НЕ применяется (деньги за мёртвый заказ)', async () => {
    state.selectStatus = 'pending';
    state.selectOrderStatus = 'cancelled';
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(false);
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text) && /orders/i.test(q.text));
    expect(upd).toBeUndefined();
  });

  it('guarded UPDATE затронул 0 строк (гонка) → false, история НЕ пишется', async () => {
    state.updateCount = 0;
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(false);
    const hist = state.queries.find((q) => /order_status_history/i.test(q.text));
    expect(hist).toBeUndefined();
  });

  it('недопустимый переход (paid→pending) → false', async () => {
    state.selectStatus = 'paid';
    const ok = await applyPaymentStatus('ord-1', 'pending');
    expect(ok).toBe(false);
  });

  it('заказ не найден (SELECT пуст) → false', async () => {
    state.selectStatus = null;
    expect(await applyPaymentStatus('ord-x', 'paid')).toBe(false);
  });
});

describe('paykeeper/repository — recordWebhookEvent (идемпотентность)', () => {
  const input = (nextStatus: 'paid' | null) => ({
    log: {
      orderId: 'ord-1',
      invoiceId: '778899',
      status: 'PAID',
      amountKop: 150000,
      isMock: false,
      rawPayload: { source: 'callback', id: '778899' },
    },
    nextStatus,
    comment: 'paykeeper-callback:PAID',
  });

  it('happy: INSERT лога вернул id, переход применён → {inserted:true, processed:true}, одна begin', async () => {
    state.selectStatus = 'pending';
    state.updateCount = 1;
    state.logInsertId = 'log-1';
    const res = await recordWebhookEvent(input('paid'));
    expect(res).toEqual({ inserted: true, processed: true });
    expect(state.beginCalls).toBe(1);
    // INSERT лога содержит ON CONFLICT (invoice_id, status) DO NOTHING.
    const ins = state.queries.find((q) => /paykeeper_payment_log/i.test(q.text) && /^INSERT/i.test(q.text));
    expect(ins!.text.toLowerCase()).toContain('on conflict');
    expect(ins!.text.toLowerCase()).toContain('invoice_id');
  });

  it('дубликат: ON CONFLICT DO NOTHING (INSERT → []) → {inserted:false, processed:false}, без перехода', async () => {
    state.logInsertId = null;
    const res = await recordWebhookEvent(input('paid'));
    expect(res).toEqual({ inserted: false, processed: false });
    const updOrders = state.queries.find((q) => /^UPDATE/i.test(q.text) && /orders/i.test(q.text));
    expect(updOrders).toBeUndefined();
  });

  it('nextStatus=null (неизвестный статус) → лог пишется, переход НЕ применяется', async () => {
    const res = await recordWebhookEvent(input(null));
    expect(res.inserted).toBe(true);
    expect(res.processed).toBe(false);
  });
});
