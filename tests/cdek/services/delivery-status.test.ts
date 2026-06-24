import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты applyDeliveryStatus (docs/08 §8.4) — атомарная смена delivery_status через
 * статус-машину canTransition('delivery', …) БЕЗ Server Actions. sql замокан.
 *
 * КЛЮЧЕВОЕ (БАГ #8/#16, MAJOR data-integrity): чтение `from` + проверка перехода +
 * запись ДОЛЖНЫ быть в ОДНОЙ транзакции с SELECT ... FOR UPDATE и guarded UPDATE
 * (WHERE delivery_status = from). Конкурентные источники (webhook СДЭК + cron
 * refresh-active + ручная смена в админке) не должны откатить статус назад
 * (delivered → in_transit): guarded UPDATE даёт rowCount=0 и переход пропускается,
 * история НЕ пишется. Это тот же приём, что в applyOrderStatusTransition / applyPaymentStatus.
 *
 * Мок транзакции (как в tests/payments/tbank/repository.test.ts):
 *   tx`SELECT ... FOR UPDATE` → [{ delivery_status }]
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
    selectStatus: 'in_transit' as string | null,
    // Сколько строк «затронул» guarded UPDATE (0 → конкурентная гонка проиграна).
    updateCount: 1,
    beginCalls: 0,
    queries: [] as TxQueryLog[],
  };

  const txTag = vi.fn((strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join('?').trim();
    state.queries.push({ text });
    if (/^SELECT/i.test(text)) {
      const rows = state.selectStatus === null ? [] : [{ delivery_status: state.selectStatus }];
      return Promise.resolve(rows);
    }
    if (/^UPDATE/i.test(text)) {
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
  };
  sqlFn.begin = vi.fn(async (cb: (tx: unknown) => unknown) => {
    state.beginCalls++;
    return cb(txTag);
  });

  return { state, txTag, sqlFn };
});

vi.mock('@/lib/db/client', () => ({ sql: h.sqlFn }));

import {
  applyDeliveryStatus,
  advanceDeliveryStatus,
} from '@/lib/cdek/services/delivery-status';

const { state } = h;

function reset(): void {
  state.selectStatus = 'in_transit';
  state.updateCount = 1;
  state.beginCalls = 0;
  state.queries = [];
  h.txTag.mockClear();
  h.sqlFn.begin.mockClear();
}

beforeEach(reset);

describe('cdek/delivery-status — applyDeliveryStatus (атомарность, БАГ #8/#16)', () => {
  it('допустимый переход in_transit → delivered применяется', async () => {
    state.selectStatus = 'in_transit';
    state.updateCount = 1;
    const ok = await applyDeliveryStatus('ord-1', 'delivered');
    expect(ok).toBe(true);
    expect(state.beginCalls).toBe(1);
  });

  it('чтение from идёт ВНУТРИ транзакции с SELECT ... FOR UPDATE до UPDATE', async () => {
    state.selectStatus = 'in_transit';
    await applyDeliveryStatus('ord-1', 'delivered');
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

  it('guarded UPDATE содержит AND delivery_status = from (анти-гонка)', async () => {
    state.selectStatus = 'in_transit';
    await applyDeliveryStatus('ord-1', 'delivered');
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text));
    expect(upd).toBeDefined();
    expect(upd!.text.toLowerCase()).toContain('delivery_status =');
    // Условие защиты «AND delivery_status = ${from}».
    expect(upd!.text.toLowerCase()).toContain('and delivery_status =');
  });

  it('guarded UPDATE затронул 0 строк (конкурентный источник) → переход НЕ применён, история НЕ пишется', async () => {
    // Сценарий гонки: SELECT прочитал in_transit (стейл), но к моменту UPDATE
    // другой источник уже выставил delivered → WHERE delivery_status='in_transit' → 0.
    state.selectStatus = 'in_transit';
    state.updateCount = 0;
    const ok = await applyDeliveryStatus('ord-1', 'delivered');
    expect(ok).toBe(false);
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(insert).toBeUndefined();
  });

  it('out-of-order: уже delivered, приходит in_transit → недопустим, история НЕ пишется', async () => {
    // canTransition('delivery', 'delivered', 'in_transit') === false → не откатываем назад.
    state.selectStatus = 'delivered';
    const ok = await applyDeliveryStatus('ord-1', 'in_transit');
    expect(ok).toBe(false);
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(insert).toBeUndefined();
  });

  it('недопустимый переход pending → delivered → false, без UPDATE/INSERT', async () => {
    state.selectStatus = 'pending';
    const ok = await applyDeliveryStatus('ord-1', 'delivered');
    expect(ok).toBe(false);
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text));
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(upd).toBeUndefined();
    expect(insert).toBeUndefined();
  });

  it('переход в тот же статус → no-op (false), без UPDATE/INSERT', async () => {
    state.selectStatus = 'in_transit';
    const ok = await applyDeliveryStatus('ord-1', 'in_transit');
    expect(ok).toBe(false);
    const upd = state.queries.find((q) => /^UPDATE/i.test(q.text));
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(upd).toBeUndefined();
    expect(insert).toBeUndefined();
  });

  it('заказ не найден (SELECT пуст) → false', async () => {
    state.selectStatus = null;
    const ok = await applyDeliveryStatus('ord-x', 'delivered');
    expect(ok).toBe(false);
  });

  it('успешный переход пишет историю (INSERT order_status_history, kind=delivery)', async () => {
    state.selectStatus = 'in_transit';
    state.updateCount = 1;
    await applyDeliveryStatus('ord-1', 'delivered');
    const insert = state.queries.find((q) => /^INSERT/i.test(q.text));
    expect(insert).toBeDefined();
    expect(insert!.text.toLowerCase()).toContain('order_status_history');
  });
});

describe('cdek/delivery-status — advanceDeliveryStatus (докрутка до target, C4-2)', () => {
  it('registered + target delivered → докручивает через in_transit: 2 UPDATE + 2 истории, true, одна транзакция', async () => {
    // C4-2: СДЭК прислал сразу DELIVERED (потерян in_transit). Прежний одношаговый
    // applyDeliveryStatus дропнул бы переход (canTransition registered→delivered=false)
    // → у клиента навсегда «registered». advance проходит цепь по шагам.
    state.selectStatus = 'registered';
    state.updateCount = 1;
    const ok = await advanceDeliveryStatus('ord-1', 'delivered', 'cdek:DELIVERED');
    expect(ok).toBe(true);
    expect(state.beginCalls).toBe(1); // всё в ОДНОЙ транзакции под FOR UPDATE
    const updates = state.queries.filter((q) => /^UPDATE/i.test(q.text));
    expect(updates).toHaveLength(2); // registered→in_transit, in_transit→delivered
    const history = state.queries.filter(
      (q) => /^INSERT/i.test(q.text) && /order_status_history/i.test(q.text),
    );
    expect(history).toHaveLength(2);
    // Каждый guarded UPDATE несёт «AND delivery_status =» (анти-гонка на каждом шаге).
    expect(updates.every((u) => u.text.toLowerCase().includes('and delivery_status ='))).toBe(true);
  });

  it('смежный одиночный шаг in_transit → delivered: 1 UPDATE + 1 история', async () => {
    state.selectStatus = 'in_transit';
    const ok = await advanceDeliveryStatus('ord-1', 'delivered', 'cdek:DELIVERED');
    expect(ok).toBe(true);
    expect(state.queries.filter((q) => /^UPDATE/i.test(q.text))).toHaveLength(1);
  });

  it('уже delivered (from === target) → no-op (false), без UPDATE/INSERT', async () => {
    state.selectStatus = 'delivered';
    const ok = await advanceDeliveryStatus('ord-1', 'delivered', 'x');
    expect(ok).toBe(false);
    expect(state.queries.some((q) => /^UPDATE/i.test(q.text))).toBe(false);
    expect(state.queries.some((q) => /^INSERT/i.test(q.text))).toBe(false);
  });

  it('out-of-order назад: delivered, target in_transit → недостижимо вперёд → false, без эффектов', async () => {
    state.selectStatus = 'delivered';
    const ok = await advanceDeliveryStatus('ord-1', 'in_transit', 'x');
    expect(ok).toBe(false);
    expect(state.queries.some((q) => /^UPDATE/i.test(q.text))).toBe(false);
  });

  it('гонка: первый шаг затронул 0 строк → false, история НЕ пишется', async () => {
    state.selectStatus = 'registered';
    state.updateCount = 0;
    const ok = await advanceDeliveryStatus('ord-1', 'delivered', 'x');
    expect(ok).toBe(false);
    expect(state.queries.some((q) => /^INSERT/i.test(q.text))).toBe(false);
  });

  it('заказ не найден (SELECT пуст) → false', async () => {
    state.selectStatus = null;
    const ok = await advanceDeliveryStatus('ord-x', 'delivered', 'x');
    expect(ok).toBe(false);
  });
});
