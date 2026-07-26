import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * АВТО-ОТМЕНА БРОШЕННЫХ НЕОПЛАЧЕННЫХ ЗАКАЗОВ (аудит 2026-07-26: критичное №4 + major №13).
 *
 * Находка №4 (ДЕНЬГИ ПОКУПАТЕЛЯ): баланс подарочного сертификата списывается в
 * транзакции СОЗДАНИЯ заказа (redeemGiftTx), а возвращается ТОЛЬКО при переходе
 * заказа в cancelled/refunded. Покупатель ушёл со страницы оплаты → крон перевёл
 * оплату в 'failed' → 5000 ₽ сгорели: заказа фактически нет, баланс не вернулся.
 * Находка №13: тот же брошенный заказ вечно держит резерв склада.
 *
 * ПОЧЕМУ ТОЧКА ВОЗВРАТА — ИМЕННО ОТМЕНА ЗАКАЗА, А НЕ payment_status='failed':
 * 'failed' в PAYMENT_STATUS_TRANSITIONS НЕ терминален (failed → pending/authorized/
 * paid): покупатель законно повторяет оплату из ЛК. Вернуть баланс на 'failed'
 * значило бы подарить скидку — заказ остался бы живым с УЖЕ УМЕНЬШЕННЫМ на номинал
 * grand_total, а сертификат снова полным. Деньги терял бы магазин. Возврат обязан
 * происходить там, где заказ окончательно НЕ состоялся, — при отмене. Поэтому
 * фикс: воркер-уборщик, отменяющий просроченные неоплаченные заказы, что ОДНОЙ
 * точкой закрывает и №4 (баланс), и №13 (резерв), и промокод.
 */

// releaseReservation / releaseGiftTx / revokeIssuedGiftsTx — мокаем: проверяем, что
// сетл отмены их дёргает (реальные требуют БД).
const { releaseSpy, releaseGiftSpy, revokeGiftSpy, sqlSpy } = vi.hoisted(() => ({
  releaseSpy: vi.fn(async () => true),
  releaseGiftSpy: vi.fn(async () => ({ reversedCount: 1, reversedAmount: '5000.00' })),
  revokeGiftSpy: vi.fn(async () => ({ revoked: [] })),
  /** Верхнеуровневый sql (выборка кандидатов): копит шаблон и аргументы запроса. */
  sqlSpy: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock('@/lib/orders/repository', () => ({ releaseReservation: releaseSpy }));
vi.mock('@/lib/gift-certificates/repository', () => ({
  releaseGiftTx: releaseGiftSpy,
  revokeIssuedGiftsTx: revokeGiftSpy,
}));
vi.mock('@/lib/db/client', () => ({ sql: sqlSpy }));

import {
  AUTO_EXPIRE_PAYMENT_METHODS,
  EXPIRABLE_ORDER_STATUSES,
  EXPIRABLE_PAYMENT_STATUSES,
  expireCutoff,
  expireUnpaidOrderTx,
  findExpiredUnpaidOrders,
  isAutoExpireEnabled,
  runExpireUnpaid,
  type ExpireUnpaidDeps,
} from '@/lib/orders/expire';

// -----------------------------------------------------------------------------
// tx-мок: отвечает по подстроке запроса, копит тексты запросов.
// -----------------------------------------------------------------------------

interface OrderRow {
  status?: string;
  payment_status?: string;
  paid_at?: Date | null;
  payment_method?: string;
  source?: string;
  promo_code_id?: string | null;
  /** Признак «создан раньше порога» — считает СУБД в самой guard-выборке. */
  expired?: boolean;
}

function makeTx(row: OrderRow | null, over: { items?: unknown[]; deleted?: unknown[] } = {}) {
  const calls: string[] = [];
  const tx = ((strings: TemplateStringsArray, ..._args: unknown[]) => {
    const text = Array.from(strings).join('?');
    calls.push(text);
    if (text.includes('FOR UPDATE') && text.includes('payment_status')) {
      // Гард-выборка воркера (status/payment_status/paid_at/payment_method/source).
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes('SELECT status, promo_code_id')) {
      // Выборка сетла закрытия заказа.
      return Promise.resolve(
        row ? [{ status: row.status, promo_code_id: row.promo_code_id ?? null }] : [],
      );
    }
    if (text.includes('FROM order_items')) return Promise.resolve(over.items ?? []);
    if (text.includes('DELETE FROM promo_redemptions')) return Promise.resolve(over.deleted ?? []);
    return Promise.resolve([]);
  }) as unknown as { (...a: unknown[]): Promise<unknown[]>; __calls: string[] };
  tx.__calls = calls;
  return tx;
}

const CUTOFF = new Date('2026-07-26T00:00:00.000Z');

function liveOrder(over: OrderRow = {}): OrderRow {
  return {
    status: 'new',
    payment_status: 'pending',
    paid_at: null,
    payment_method: 'card',
    source: 'storefront',
    promo_code_id: null,
    expired: true,
    ...over,
  };
}

beforeEach(() => {
  releaseSpy.mockClear();
  releaseGiftSpy.mockClear();
  revokeGiftSpy.mockClear();
});

// =============================================================================
// Чистая часть: порог и признак включённости.
// =============================================================================

describe('expireCutoff / isAutoExpireEnabled — чистая арифметика TTL', () => {
  it('порог = now − ttl минут', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    expect(expireCutoff(now, 90).toISOString()).toBe('2026-07-26T10:30:00.000Z');
  });

  it('ttl = 0 → авто-отмена ВЫКЛЮЧЕНА (владелец может отключить уборщик)', () => {
    expect(isAutoExpireEnabled(0)).toBe(false);
    expect(isAutoExpireEnabled(1)).toBe(true);
  });

  it('отрицательный/нечисловой ttl трактуется как выключено (fail-safe)', () => {
    expect(isAutoExpireEnabled(-10)).toBe(false);
    expect(isAutoExpireEnabled(Number.NaN)).toBe(false);
  });

  it('авто-отмене подлежат только «живые неоплаченные» статусы и предоплатные способы', () => {
    // Резерв ещё держится ровно в этих статусах заказа.
    expect([...EXPIRABLE_ORDER_STATUSES]).toEqual(['new', 'awaiting_payment']);
    expect([...EXPIRABLE_PAYMENT_STATUSES]).toEqual(['pending', 'failed']);
    // COD/счёт/cdek_pay/unset НЕ отменяем: их «неоплаченность» — норма месяцами.
    expect([...AUTO_EXPIRE_PAYMENT_METHODS]).toEqual(['card', 'sbp']);
  });
});

// =============================================================================
// Атомарный сетл одного заказа (гард под FOR UPDATE).
// =============================================================================

describe('expireUnpaidOrderTx — отмена просроченного заказа в транзакции', () => {
  it('брошенный заказ: резерв освобождён, баланс сертификата возвращён, статус cancelled', async () => {
    const tx = makeTx(liveOrder({ promo_code_id: 'promo-1' }), {
      items: [{ product_id: 'p1', variant_id: null, quantity: 1 }],
      deleted: [{ id: 'r1' }],
    });
    const out = await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF);
    expect(out).toBe('cancelled');
    // (а) резерв склада вернулся в продажу (major №13)
    expect(releaseSpy).toHaveBeenCalledWith(tx, { productId: 'p1', variantId: null, qty: 1 });
    // (б) БАЛАНС СЕРТИФИКАТА ВЕРНУЛСЯ ДЕРЖАТЕЛЮ (критичное №4)
    expect(releaseGiftSpy).toHaveBeenCalledWith(tx, { orderId: 'order-1' });
    // (в) выпущенные по заказу коды погашены (симметрия), промокод откатан
    expect(revokeGiftSpy).toHaveBeenCalledWith(tx, { orderId: 'order-1' });
    const calls = tx.__calls.join('||');
    expect(calls).toContain('DELETE FROM promo_redemptions');
    expect(calls).toMatch(/UPDATE orders\s+SET status = 'cancelled'/);
    expect(calls).toContain('order_status_history');
  });

  it('🔴 ГОНКА: оплата пришла между выборкой и сетлом (payment_status=paid) → НЕ отменяем', async () => {
    // Ключевой сценарий безопасности: вебхук пометил заказ оплаченным, order.status
    // при этом остаётся 'new'. Отмена «по кандидату» вернула бы баланс сертификата
    // и резерв по РЕАЛЬНО ОПЛАЧЕННОМУ заказу. Гард перечитывает строку под FOR UPDATE.
    const tx = makeTx(liveOrder({ payment_status: 'paid' }));
    const out = await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF);
    expect(out).toBe('skipped');
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(releaseGiftSpy).not.toHaveBeenCalled();
    expect(tx.__calls.join('||')).not.toContain('UPDATE orders');
  });

  it('🔴 ГОНКА: paid_at проставлен, а payment_status ещё «pending» → НЕ отменяем', async () => {
    const tx = makeTx(liveOrder({ paid_at: new Date('2026-07-26T11:00:00.000Z') }));
    expect(await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF)).toBe('skipped');
    expect(releaseGiftSpy).not.toHaveBeenCalled();
  });

  it('заказ уже продвинут оператором (packed) → НЕ отменяем', async () => {
    const tx = makeTx(liveOrder({ status: 'packed' }));
    expect(await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF)).toBe('skipped');
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('идемпотентность: заказ уже cancelled → no-op, баланс НЕ возвращается второй раз', async () => {
    const tx = makeTx(liveOrder({ status: 'cancelled' }));
    expect(await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF)).toBe('skipped');
    expect(releaseGiftSpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('наложенный платёж (cod) и счёт (invoice) не отменяются никогда', async () => {
    for (const method of ['cod', 'invoice', 'cdek_pay', 'unset']) {
      releaseGiftSpy.mockClear();
      const tx = makeTx(liveOrder({ payment_method: method }));
      expect(await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF), method).toBe('skipped');
      expect(releaseGiftSpy).not.toHaveBeenCalled();
    }
  });

  it('ручной заказ оператора (source=admin) не отменяется автоматически', async () => {
    const tx = makeTx(liveOrder({ source: 'admin' }));
    expect(await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF)).toBe('skipped');
  });

  it('порог ещё не наступил (заказ свежий) → НЕ отменяем', async () => {
    const tx = makeTx(liveOrder({ expired: false }));
    expect(await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF)).toBe('skipped');
    expect(releaseGiftSpy).not.toHaveBeenCalled();
  });

  it('заказ исчез (не найден) → no-op', async () => {
    const tx = makeTx(null);
    expect(await expireUnpaidOrderTx(tx as never, 'gone', CUTOFF)).toBe('skipped');
    expect(releaseGiftSpy).not.toHaveBeenCalled();
  });

  it('гард в SQL: строка перечитывается FOR UPDATE и сверяется с порогом created_at', async () => {
    const tx = makeTx(liveOrder());
    await expireUnpaidOrderTx(tx as never, 'order-1', CUTOFF);
    const guard = tx.__calls.find((c) => c.includes('FOR UPDATE') && c.includes('payment_status'));
    expect(guard, 'нет перечитывания строки заказа под блокировкой').toBeTruthy();
    expect(guard!).toContain('created_at');
  });
});

// =============================================================================
// Выборка кандидатов (текст запроса — единственное, что можно проверить без БД).
// =============================================================================

describe('findExpiredUnpaidOrders — кого вообще берём в уборку', () => {
  it('фильтрует по статусу, оплате, paid_at, способу оплаты, источнику и порогу', async () => {
    sqlSpy.mockClear();
    await findExpiredUnpaidOrders(CUTOFF, 50);
    expect(sqlSpy).toHaveBeenCalledTimes(1);
    const call = sqlSpy.mock.calls[0]!;
    const text = Array.from(call[0] as unknown as TemplateStringsArray).join('?');
    const args = call.slice(1);

    expect(text).toContain('FROM orders');
    expect(text).toContain('status = ANY(');
    expect(text).toContain('payment_status = ANY(');
    expect(text).toContain('paid_at IS NULL');
    expect(text).toContain('payment_method = ANY(');
    expect(text).toContain('source =');
    expect(text).toContain('created_at <');
    // Списки и порог уходят ПАРАМЕТРАМИ (никакой склейки строк).
    expect(args).toContainEqual([...EXPIRABLE_ORDER_STATUSES]);
    expect(args).toContainEqual([...EXPIRABLE_PAYMENT_STATUSES]);
    expect(args).toContainEqual([...AUTO_EXPIRE_PAYMENT_METHODS]);
    expect(args).toContain(CUTOFF);
    expect(args).toContain(50);
  });
});

// =============================================================================
// Воркер прогона.
// =============================================================================

describe('runExpireUnpaid — крон-воркер уборки', () => {
  function deps(over: Partial<ExpireUnpaidDeps> = {}): ExpireUnpaidDeps {
    return {
      ttlMinutes: 1440,
      now: () => Date.parse('2026-07-26T12:00:00.000Z'),
      withLock: async (_key, fn) => ({ acquired: true, result: await fn() }),
      findCandidates: async () => [
        { id: 'o1', number: 'A-1' },
        { id: 'o2', number: 'A-2' },
      ],
      expireOne: async () => 'cancelled',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      ...over,
    };
  }

  it('отменяет всех кандидатов и считает статистику', async () => {
    const stats = await runExpireUnpaid(deps());
    expect(stats).toMatchObject({ ok: true, scanned: 2, cancelled: 2, skipped: 0, failed: 0 });
  });

  it('ttl=0 → выключено: кандидаты даже не читаются', async () => {
    const findCandidates = vi.fn(async () => []);
    const stats = await runExpireUnpaid(deps({ ttlMinutes: 0, findCandidates }));
    expect(stats).toMatchObject({ ok: true, disabled: true, scanned: 0, cancelled: 0 });
    expect(findCandidates).not.toHaveBeenCalled();
  });

  it('лок занят параллельным прогоном → lockSkipped, кандидаты не читаются', async () => {
    const findCandidates = vi.fn(async () => []);
    const stats = await runExpireUnpaid(
      deps({ withLock: async () => ({ acquired: false }), findCandidates }),
    );
    expect(stats).toMatchObject({ ok: true, lockSkipped: true, scanned: 0 });
    expect(findCandidates).not.toHaveBeenCalled();
  });

  it('падение по одному заказу не валит прогон (failed++, остальные обработаны)', async () => {
    const expireOne = vi.fn(async (id: string) => {
      if (id === 'o1') throw new Error('deadlock');
      return 'cancelled' as const;
    });
    const stats = await runExpireUnpaid(deps({ expireOne }));
    expect(stats).toMatchObject({ ok: false, scanned: 2, cancelled: 1, failed: 1 });
  });

  it('пропуск по гарду (оплата пришла) — не ошибка: skipped++, ok остаётся true', async () => {
    const stats = await runExpireUnpaid(deps({ expireOne: async () => 'skipped' }));
    expect(stats).toMatchObject({ ok: true, scanned: 2, cancelled: 0, skipped: 2, failed: 0 });
  });

  it('порог считается от now − ttl и передаётся в выборку кандидатов', async () => {
    const seen: Date[] = [];
    const findCandidates = async (cutoff: Date) => {
      seen.push(cutoff);
      return [];
    };
    await runExpireUnpaid(deps({ ttlMinutes: 60, findCandidates }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toISOString()).toBe('2026-07-26T11:00:00.000Z');
  });
});
