import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты applyPaymentStatus (docs/15 §4.4) — атомарная смена payment_status через
 * статус-машину canTransition БЕЗ Server Actions. sql замокан.
 *
 * КЛЮЧЕВОЕ (MAJOR data-integrity): чтение `from` + проверка перехода + запись
 * ДОЛЖНЫ быть в ОДНОЙ транзакции с SELECT ... FOR UPDATE и guarded UPDATE
 * (WHERE payment_status = from). Конкурентный/out-of-order webhook не должен
 * откатить уже выставленный статус (paid → authorized) — guarded UPDATE даёт
 * rowCount=0 и переход пропускается даже если canTransition по «прочитанному»
 * значению формально прошёл.
 *
 * Мок транзакции:
 *   tx`SELECT ... FOR UPDATE` → [{ payment_status }]
 *   tx`UPDATE orders ...`     → массив с .count (postgres.js даёт count у результата)
 *   tx`INSERT order_status_history ...` → []
 * Различаем запросы по тексту первого фрагмента tagged-template.
 */

interface TxQueryLog {
  text: string;
}

const h = vi.hoisted(() => {
  const state = {
    // Значение, которое вернёт SELECT ... FOR UPDATE (фактическое в БД на момент tx).
    selectStatus: 'authorized' as string | null,
    // orders.status того же SELECT (C4-1: гард мёртвого заказа на сетле). Дефолт —
    // активный (не cancelled/refunded), чтобы существующие сценарии не блокировались.
    selectOrderStatus: 'awaiting_payment' as string,
    // Сколько строк «затронул» guarded UPDATE orders (0 → конкурентная гонка проиграна).
    updateCount: 1,
    // id, который вернёт INSERT INTO tbank_payment_log ... RETURNING id (null → дубликат).
    logInsertId: 'log-1' as string | null,
    // Если true — UPDATE orders (применение статуса) бросит исключение (регресс на баг
    // атомарности: сбой обязан откатить всю транзакцию, включая вставку лога).
    throwOnUpdateOrders: false,
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
    if (/^INSERT/i.test(text) && /tbank_payment_log/i.test(text)) {
      // Идемпотентная вставка лога: id → новое событие, [] → дубликат (ON CONFLICT).
      const rows = state.logInsertId === null ? [] : [{ id: state.logInsertId }];
      return Promise.resolve(rows);
    }
    if (/^UPDATE/i.test(text) && /tbank_payment_log/i.test(text)) {
      // Пометка лога обработанным внутри атомарной recordWebhookEvent.
      return Promise.resolve([]);
    }
    if (/^UPDATE/i.test(text)) {
      // UPDATE orders (применение payment_status). Может бросить — регресс на баг.
      if (state.throwOnUpdateOrders) {
        return Promise.reject(new Error('db transient failure on UPDATE orders'));
      }
      const arr: unknown[] = [];
      (arr as unknown as { count: number }).count = state.updateCount;
      return Promise.resolve(arr);
    }
    // INSERT history и прочее.
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
  // sql.json — сериализационный хелпер (не запрос): возвращает значение-обёртку.
  sqlFn.json = vi.fn((v: unknown) => v);

  return { state, txTag, sqlFn };
});

vi.mock('@/lib/db/client', () => ({ sql: h.sqlFn }));

import { applyPaymentStatus, recordWebhookEvent } from '@/lib/payments/tbank/repository';

const { state } = h;

function reset(): void {
  state.selectStatus = 'authorized';
  state.selectOrderStatus = 'awaiting_payment';
  state.updateCount = 1;
  state.logInsertId = 'log-1';
  state.throwOnUpdateOrders = false;
  state.beginCalls = 0;
  state.queries = [];
  h.txTag.mockClear();
  h.sqlFn.begin.mockClear();
}

beforeEach(reset);

describe('tbank/repository — applyPaymentStatus (атомарность)', () => {
  it('допустимый переход authorized → paid применяется', async () => {
    state.selectStatus = 'authorized';
    state.updateCount = 1;
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(true);
  });

  it('чтение from идёт ВНУТРИ транзакции с SELECT ... FOR UPDATE', async () => {
    state.selectStatus = 'authorized';
    await applyPaymentStatus('ord-1', 'paid');
    expect(state.beginCalls).toBe(1);
    const select = state.queries.find((q) => /^SELECT/i.test(q.text));
    expect(select).toBeDefined();
    expect(select!.text.toUpperCase()).toContain('FOR UPDATE');
    // SELECT должен быть до UPDATE (внутри той же транзакции).
    const idxSelect = state.queries.findIndex((q) => /^SELECT/i.test(q.text));
    const idxUpdate = state.queries.findIndex((q) => /^UPDATE/i.test(q.text));
    expect(idxSelect).toBeGreaterThanOrEqual(0);
    expect(idxUpdate).toBeGreaterThan(idxSelect);
  });

  it('guarded UPDATE содержит WHERE по payment_status = from (анти-гонка)', async () => {
    state.selectStatus = 'authorized';
    await applyPaymentStatus('ord-1', 'paid');
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text));
    expect(upd).toBeDefined();
    expect(upd!.text.toLowerCase()).toContain('payment_status =');
    // Условие защиты «AND payment_status = ${from}».
    expect(upd!.text.toLowerCase()).toContain('and payment_status =');
  });

  it('guarded UPDATE затронул 0 строк (конкурентный webhook) → переход НЕ применён, история НЕ пишется', async () => {
    // Сценарий гонки: SELECT прочитал authorized (стейл), но к моменту UPDATE
    // другой webhook уже выставил paid → WHERE payment_status='authorized' даёт 0.
    state.selectStatus = 'authorized';
    state.updateCount = 0;
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(false);
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(insert).toBeUndefined();
  });

  it('out-of-order: уже paid, приходит authorized → недопустим, история НЕ пишется', async () => {
    // canTransition('payment', 'paid', 'authorized') === false.
    state.selectStatus = 'paid';
    const ok = await applyPaymentStatus('ord-1', 'authorized');
    expect(ok).toBe(false);
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(insert).toBeUndefined();
  });

  it('from === to → no-op (false), без UPDATE/INSERT', async () => {
    state.selectStatus = 'paid';
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(false);
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text));
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(upd).toBeUndefined();
    expect(insert).toBeUndefined();
  });

  it('заказ не найден (SELECT пуст) → false', async () => {
    state.selectStatus = null;
    const ok = await applyPaymentStatus('ord-x', 'paid');
    expect(ok).toBe(false);
  });

  it('paid проставляет paid_at в UPDATE', async () => {
    state.selectStatus = 'authorized';
    await applyPaymentStatus('ord-1', 'paid');
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text));
    expect(upd!.text.toLowerCase()).toContain('paid_at');
  });

  it('успешный переход пишет историю (INSERT order_status_history)', async () => {
    state.selectStatus = 'authorized';
    state.updateCount = 1;
    await applyPaymentStatus('ord-1', 'paid');
    const insert = state.queries.find(
      (q) => /^INSERT/i.test(q.text) && /order_status_history/i.test(q.text),
    );
    expect(insert).toBeDefined();
    expect(insert!.text.toLowerCase()).toContain('order_status_history');
  });
});

describe('tbank/repository — recordWebhookEvent (атомарность)', () => {
  const baseInput = (nextStatus: 'paid' | 'failed' | null) => ({
    log: {
      orderId: 'ord-1',
      paymentId: '900000001',
      status: 'CONFIRMED',
      amountKop: 150000,
      isMock: false,
      rawPayload: { OrderId: '2026-000123', Status: 'CONFIRMED' },
    },
    nextStatus,
    comment: 'tbank-webhook:CONFIRMED',
  });

  it('happy: INSERT лога вернул id, переход применён → {inserted:true, processed:true}, всё в ОДНОЙ begin', async () => {
    state.selectStatus = 'authorized';
    state.updateCount = 1;
    state.logInsertId = 'log-1';
    const res = await recordWebhookEvent(baseInput('paid'));
    expect(res).toEqual({ inserted: true, processed: true });
    // ВСЯ работа в одной транзакции (вставка лога + применение статуса + пометка).
    expect(state.beginCalls).toBe(1);
    // INSERT лога, UPDATE orders, INSERT history, UPDATE tbank_payment_log (processed).
    const logInsert = state.queries.find(
      (q) => /^INSERT/i.test(q.text) && /tbank_payment_log/i.test(q.text),
    );
    expect(logInsert).toBeDefined();
    const logUpdate = state.queries.find(
      (q) => /^UPDATE/i.test(q.text) && /tbank_payment_log/i.test(q.text),
    );
    expect(logUpdate).toBeDefined();
    expect(logUpdate!.text.toLowerCase()).toContain('processed = true');
  });

  it('дубликат: INSERT лога вернул [] (ON CONFLICT) → {inserted:false, processed:false}, переход НЕ применялся', async () => {
    state.logInsertId = null; // дубликат
    const res = await recordWebhookEvent(baseInput('paid'));
    expect(res).toEqual({ inserted: false, processed: false });
    // Переход не применялся: нет UPDATE orders / INSERT history / UPDATE лога.
    const orderUpdate = state.queries.find(
      (q) => /^UPDATE/i.test(q.text) && !/tbank_payment_log/i.test(q.text),
    );
    expect(orderUpdate).toBeUndefined();
    const history = state.queries.find(
      (q) => /^INSERT/i.test(q.text) && /order_status_history/i.test(q.text),
    );
    expect(history).toBeUndefined();
    const logUpdate = state.queries.find(
      (q) => /^UPDATE/i.test(q.text) && /tbank_payment_log/i.test(q.text),
    );
    expect(logUpdate).toBeUndefined();
  });

  it('неизвестный статус (nextStatus null) → {inserted:true, processed:false}, но лог помечен обработанным', async () => {
    state.logInsertId = 'log-1';
    const res = await recordWebhookEvent(baseInput(null));
    expect(res).toEqual({ inserted: true, processed: false });
    // Переход не применялся (нет UPDATE orders), но пометка лога processed выполнена.
    const orderUpdate = state.queries.find(
      (q) => /^UPDATE/i.test(q.text) && !/tbank_payment_log/i.test(q.text),
    );
    expect(orderUpdate).toBeUndefined();
    const logUpdate = state.queries.find(
      (q) => /^UPDATE/i.test(q.text) && /tbank_payment_log/i.test(q.text),
    );
    expect(logUpdate).toBeDefined();
    expect(logUpdate!.text.toLowerCase()).toContain('processed = true');
  });

  it('АТОМАРНОСТЬ (регресс на баг): сбой UPDATE orders → reject, лог НЕ помечен processed (вставка откатится)', async () => {
    state.selectStatus = 'authorized';
    state.logInsertId = 'log-1';
    state.throwOnUpdateOrders = true; // транзиентный сбой БД на применении статуса
    await expect(recordWebhookEvent(baseInput('paid'))).rejects.toThrow();
    // Пометка лога processed НЕ достигнута — исключение прервало транзакцию ДО неё.
    // (В реальной БД sql.begin откатил бы и сам INSERT лога, поэтому повтор события
    // снова даст inserted=true и переприменит статус — баг неатомарности закрыт.)
    const logUpdate = state.queries.find(
      (q) => /^UPDATE/i.test(q.text) && /tbank_payment_log/i.test(q.text),
    );
    expect(logUpdate).toBeUndefined();
  });
});

describe('tbank/repository — гард мёртвого заказа на сетле (C4-1, деньги)', () => {
  // Гонка: клиент на шлюзе → админ отменяет заказ (резерв отпущен, payment остаётся
  // pending/authorized) → клиент дожимает оплату → CONFIRMED-webhook. Прежде гард
  // order.status был ТОЛЬКО в initPayment, не на сетл-пути → отменённый заказ метился
  // paid (деньги за мёртвый заказ + риск оверселла). Зеркалит isOrderPayable.
  function hasOrderUpdate(): boolean {
    return state.queries.some(
      (q) => /^UPDATE/i.test(q.text) && /orders/i.test(q.text) && !/tbank_payment_log/i.test(q.text),
    );
  }
  function hasPaymentHistory(): boolean {
    return state.queries.some(
      (q) => /^INSERT/i.test(q.text) && /order_status_history/i.test(q.text),
    );
  }

  it('CONFIRMED (authorized→paid) на ОТМЕНЁННОМ заказе → НЕ применяется (false), без UPDATE orders и истории', async () => {
    state.selectStatus = 'authorized';
    state.selectOrderStatus = 'cancelled';
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(false);
    expect(hasOrderUpdate()).toBe(false);
    expect(hasPaymentHistory()).toBe(false);
  });

  it('CONFIRMED (pending→paid) на ВОЗВРАЩЁННОМ заказе → false', async () => {
    state.selectStatus = 'pending';
    state.selectOrderStatus = 'refunded';
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(false);
    expect(hasOrderUpdate()).toBe(false);
  });

  it('AUTHORIZED (pending→authorized) на отменённом заказе → false (авто-холд денег тоже блокируем)', async () => {
    state.selectStatus = 'pending';
    state.selectOrderStatus = 'cancelled';
    const ok = await applyPaymentStatus('ord-1', 'authorized');
    expect(ok).toBe(false);
    expect(hasOrderUpdate()).toBe(false);
  });

  it('paid на АКТИВНОМ заказе (awaiting_payment) применяется как обычно (гард не мешает)', async () => {
    state.selectStatus = 'authorized';
    state.selectOrderStatus = 'awaiting_payment';
    const ok = await applyPaymentStatus('ord-1', 'paid');
    expect(ok).toBe(true);
    expect(hasOrderUpdate()).toBe(true);
  });

  it('REFUNDED (paid→refunded) на отменённом заказе ВСЁ РАВНО применяется — возврат денег не пере-блокируем', async () => {
    // Гард завязан только на target paid/authorized; возврат — легитимный пост-отменный
    // переход (оператор оформляет возврат). from='paid', settle no-op (заказ уже cancelled).
    state.selectStatus = 'paid';
    state.selectOrderStatus = 'cancelled';
    const ok = await applyPaymentStatus('ord-1', 'refunded');
    expect(ok).toBe(true);
  });

  it('webhook: CONFIRMED на отменённом заказе → лог записан, переход НЕ применён (inserted:true, processed:false), лог помечен обработанным (идемпотентный OK)', async () => {
    state.selectStatus = 'authorized';
    state.selectOrderStatus = 'cancelled';
    state.logInsertId = 'log-9';
    const res = await recordWebhookEvent({
      log: {
        orderId: 'ord-1',
        paymentId: '900000099',
        status: 'CONFIRMED',
        amountKop: 150000,
        isMock: false,
        rawPayload: null,
      },
      nextStatus: 'paid',
      comment: 'tbank-webhook:CONFIRMED',
    });
    expect(res).toEqual({ inserted: true, processed: false });
    expect(hasOrderUpdate()).toBe(false);
    const logUpdate = state.queries.find(
      (q) => /^UPDATE/i.test(q.text) && /tbank_payment_log/i.test(q.text),
    );
    expect(logUpdate).toBeDefined();
    expect(logUpdate!.text.toLowerCase()).toContain('processed = true');
  });
});
