import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ЮНИТ-тесты Server Actions админки orders (пакет 3.C) — БЕЗ БД/Next.
 *
 * Реальные actions (lib/orders/actions.ts) импортируют repository и sql напрямую,
 * поэтому изолируем их vi.mock-ами:
 *   • @/lib/auth/session.getCurrentUser → подменяемый текущий пользователь (guard);
 *   • @/lib/db/client.sql              → мок c .begin (транзакция) + tagged-template;
 *   • @/lib/orders/repository          → мок getOrderById / release / commit / createOrder;
 *   • @/lib/audit/log.writeAudit       → шпион (проверяем формирование записи);
 *   • next/cache.revalidatePath        → no-op.
 *
 * Проверяем: guard (нет orders.write → forbidden, unauthorized, owner проходит),
 * валидацию (невалидный переход статуса отклонён, Zod-ошибки промокода),
 * вызов release при отмене, формирование audit-записи. БД не дёргается.
 */

// --- управляемое состояние моков ---------------------------------------------

// Состояние мок-окружения. Объявлено через vi.hoisted, т.к. vi.mock-фабрики
// поднимаются на верх файла и иначе обращались бы к ещё не инициализированным
// переменным (ReferenceError при изолированном запуске файла).
const H = vi.hoisted(() => {
  const state = {
    currentUser: null as AuthUser | null,
    getOrderByIdQueue: [] as unknown[],
    /**
     * Очередь результатов для запросов ВНУТРИ транзакции (tx`...`). Каждый вызов
     * tagged-template tx снимает один элемент. По умолчанию (пусто) → []. Нужна
     * для проверки guarded-UPDATE (Fix 1: UPDATE ... WHERE status=from RETURNING id
     * → affected rows контролируем сюда) и отката промокода (Fix 4).
     */
    txResultQueue: [] as unknown[][],
    /** Лог SQL-запросов внутри транзакции (строки шаблонов) — для проверок Fix 1/4. */
    txCalls: [] as string[][],
    /**
     * Лог tx-запросов с интерполированными аргументами — для проверок, что
     * UPDATE промокода НЕ затирает поля дефолтами при partial-update (Fix #17/#18).
     * Каждый элемент: { strings: статические куски, args: значения интерполяции }.
     */
    txCallsWithArgs: [] as { strings: string[]; args: unknown[] }[],
  };
  // sql.begin как управляемый спай: по умолчанию выполняет колбэк с tx-моком.
  // tx`...` снимает результат из txResultQueue, а если очередь пуста — возвращает
  // ОДНУ строку [{ id }] по умолчанию. Это нужно, чтобы guarded UPDATE (Fix 1:
  // `... RETURNING id`) по умолчанию считался успешным (affected rows = 1) и
  // happy-path тесты переходов проходили. Для проверки КОНФЛИКТА тест кладёт в
  // txResultQueue пустой массив [] (0 строк) как результат первого UPDATE.
  const DEFAULT_TX_ROW = [{ id: 'tx-row-id' }];
  const sqlBeginMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray, ...args: unknown[]) => {
      // Записываем шаблон (склейку статических кусков) — позволяет утверждать
      // наличие «AND status =» / «promo_redemptions» / «used_count» в запросе.
      state.txCalls.push(Array.from(strings ?? []));
      state.txCallsWithArgs.push({ strings: Array.from(strings ?? []), args });
      const next = state.txResultQueue.length > 0 ? state.txResultQueue.shift()! : DEFAULT_TX_ROW;
      return Promise.resolve(next);
    };
    (tx as unknown as { json: unknown }).json = (v: unknown) => v;
    return cb(tx);
  });
  // sql как tagged-template-спай: по умолчанию возвращает [] (как раньше), но это
  // vi.fn — тесты могут переопределить ОДИН вызов (mockImplementationOnce), чтобы
  // SELECT существующего промокода в updatePromoCode вернул строку.
  const sqlMock = vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[]));
  (sqlMock as unknown as { begin: unknown }).begin = sqlBeginMock;
  (sqlMock as unknown as { json: unknown }).json = (v: unknown) => v;
  return {
    state,
    sqlBeginMock,
    sqlMock,
    writeAuditSpy: vi.fn(async (..._args: unknown[]) => {}),
    // Шлюзовой возврат Т-Банка (Фича #15). По умолчанию — успех (ok:true), чтобы
    // refundOrder доходил до перехода. Отдельные тесты подменяют на ok:false.
    refundPaymentMock: vi.fn(
      async (
        ..._args: unknown[]
      ): Promise<{
        ok: boolean;
        status: string | null;
        isMock: boolean;
        skipped?: boolean;
        reason?: string;
      }> => ({
        ok: true,
        status: 'REFUNDED',
        isMock: true,
        skipped: false,
      }),
    ),
    getCurrentUserMock: vi.fn(async () => state.currentUser),
    getOrderByIdMock: vi.fn(async (..._args: unknown[]) => state.getOrderByIdQueue.shift() ?? null),
    releaseReservationMock: vi.fn(async (..._args: unknown[]) => true),
    commitReservationMock: vi.fn(async (..._args: unknown[]) => true),
    createOrderMock: vi.fn(async (..._args: unknown[]) => ({
      ok: true as const,
      reused: false,
      order: { id: 'o-new', number: 'GA-2026-000001', grandTotal: '100.00', source: 'admin' },
    })),
  };
});

const {
  sqlBeginMock,
  sqlMock,
  writeAuditSpy,
  refundPaymentMock,
  getCurrentUserMock,
  getOrderByIdMock,
  releaseReservationMock,
  commitReservationMock,
  createOrderMock,
} = H;

// --- vi.mock (hoisted) -------------------------------------------------------

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: H.getCurrentUserMock,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/audit/log', () => ({
  writeAudit: (...args: unknown[]) => H.writeAuditSpy(...(args as [])),
}));

// Гейт модуля теперь авторитетный (env ⊕ БД) и живёт в @/lib/config/settings.
// Мокаем его как «модуль включён», чтобы тестировать бизнес-логику без БД.
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: async () => true,
}));

// next/headers недоступен в node-окружении vitest — мокаем getRequestMeta косвенно
// через мок next/headers (defineAction импортирует его динамически).
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
}));

// sql: tagged-template-спай H.sqlMock (по умолчанию []); sql.begin — управляемый
// спай H.sqlBeginMock (выполняет колбэк с tx-моком, снимающим txResultQueue).
vi.mock('@/lib/db/client', () => ({
  sql: H.sqlMock,
}));

vi.mock('@/lib/orders/repository', () => ({
  getOrderById: H.getOrderByIdMock,
  releaseReservation: H.releaseReservationMock,
  commitReservation: H.commitReservationMock,
  createOrder: H.createOrderMock,
  // мапперы реэкспортируются модулем — actions их типизирует, но в рантайме не зовёт
  mapOrder: (r: unknown) => r,
  mapOrderItem: (r: unknown) => r,
}));

// Платёжный модуль (Фича #15): refundOrder дёргает PaymentService.refundPayment
// ДО смены статуса. Мокаем его классом (вызывается через `new`), чтобы тест был
// детерминированным (без env/сети).
vi.mock('@/lib/payments/tbank', () => ({
  PaymentService: class {
    refundPayment(...a: unknown[]) {
      return H.refundPaymentMock(...(a as []));
    }
  },
  toKopecks: (v: string | number) => Math.round(Number(v) * 100),
}));

// Импорт actions ПОСЛЕ моков.
import {
  changeOrderStatus,
  cancelOrder,
  refundOrder,
  setPaymentStatus,
  setDeliveryStatus,
  createManualOrder,
  getOrder,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  deactivatePromoCode,
} from '@/lib/orders/actions';

// --- хелперы -----------------------------------------------------------------

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return {
    id: 'u-1',
    email: 'u@shop.io',
    isOwner,
    permissions: new Set<PermissionCode>(perms),
  };
}

const UUID = '11111111-1111-4111-8111-111111111111';

function orderDetail(over: Record<string, unknown> = {}) {
  return {
    order: {
      id: UUID,
      number: 'GA-2026-000001',
      status: 'new',
      paymentStatus: 'pending',
      deliveryStatus: 'pending',
      ...over,
    },
    items: [
      { productId: 'p-1', variantId: null, quantity: 2, skuSnapshot: 'SKU-1' },
    ],
  };
}

beforeEach(() => {
  H.state.currentUser = makeUser(['orders.read', 'orders.write']);
  H.state.getOrderByIdQueue = [];
  H.state.txResultQueue = [];
  H.state.txCalls = [];
  H.state.txCallsWithArgs = [];
  sqlBeginMock.mockClear();
  sqlMock.mockClear();
  writeAuditSpy.mockClear();
  getOrderByIdMock.mockClear();
  releaseReservationMock.mockClear();
  commitReservationMock.mockClear();
  createOrderMock.mockClear();
  refundPaymentMock.mockClear();
  refundPaymentMock.mockResolvedValue({ ok: true, status: 'REFUNDED', isMock: true, skipped: false });
});

afterEach(() => {
  vi.clearAllMocks();
  // clearAllMocks чистит историю вызовов, но НЕ кастомную реализацию. Тесты,
  // подменяющие реализацию release/commit (анти-oversell сценарий с состоянием
  // inventory), могли бы протечь в соседние — реинсталлируем дефолт (return true).
  releaseReservationMock.mockImplementation(async () => true);
  commitReservationMock.mockImplementation(async () => true);
});

// =============================================================================
// GUARD (orders.read / orders.write).
// =============================================================================

describe('guard прав', () => {
  it('не аутентифицирован → unauthorized', async () => {
    H.state.currentUser = null;
    const res = await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('нет orders.write → forbidden (только orders.read)', async () => {
    H.state.currentUser = makeUser(['orders.read']);
    const res = await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('orders.write проходит guard (валидный переход new→paid)', async () => {
    H.state.currentUser = makeUser(['orders.write']);
    H.state.getOrderByIdQueue = [orderDetail({ status: 'new' }), orderDetail({ status: 'paid' })];
    const res = await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(true);
  });

  it('owner проходит без явного права', async () => {
    H.state.currentUser = makeUser([], true);
    H.state.getOrderByIdQueue = [orderDetail({ status: 'new' }), orderDetail({ status: 'paid' })];
    const res = await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(true);
  });

  it('getOrder требует orders.read → forbidden без права', async () => {
    H.state.currentUser = makeUser([]);
    const res = await getOrder({ id: UUID });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('createPromoCode требует orders.write → forbidden с orders.read', async () => {
    H.state.currentUser = makeUser(['orders.read']);
    const res = await createPromoCode({ code: 'SALE', kind: 'fixed', value: '100' });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });
});

// =============================================================================
// ВАЛИДАЦИЯ ПЕРЕХОДА СТАТУСА (status.ts canTransition).
// =============================================================================

describe('валидация перехода статуса', () => {
  it('недопустимый переход new→shipped → validation + message (OrderError), история не пишется', async () => {
    // OrderError extends PublicActionError → пайплайн отдаёт error:'validation' + текст.
    H.state.getOrderByIdQueue = [orderDetail({ status: 'new' })];
    const res = await changeOrderStatus({ id: UUID, to: 'shipped' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('Недопустимый переход');
    expect(releaseReservationMock).not.toHaveBeenCalled();
    expect(commitReservationMock).not.toHaveBeenCalled();
  });

  it('недопустимый переход оплаты pending→refunded → validation + message', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ paymentStatus: 'pending' })];
    const res = await setPaymentStatus({ id: UUID, to: 'refunded' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('Недопустимый переход статуса оплаты');
  });

  it('недопустимый переход доставки pending→delivered → validation + message', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ deliveryStatus: 'pending' })];
    const res = await setDeliveryStatus({ id: UUID, to: 'delivered' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('Недопустимый переход статуса доставки');
  });

  it('допустимый переход доставки pending→registered → ok', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ deliveryStatus: 'pending' }),
      orderDetail({ deliveryStatus: 'registered' }),
    ];
    const res = await setDeliveryStatus({ id: UUID, to: 'registered' });
    expect(res.ok).toBe(true);
  });

  it('C5-1: оплата paid на ОТМЕНЁННОМ заказе → validation + message (гард мёртвого заказа, anti-tamper)', async () => {
    // Переход payment pending→paid сам по себе валиден, но заказ отменён (резерв
    // отпущен) → пометить оплаченным нельзя. Зеркало webhook-гарда C4-1 на админ-пути.
    H.state.getOrderByIdQueue = [orderDetail({ status: 'cancelled', paymentStatus: 'pending' })];
    const res = await setPaymentStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('отменённого');
  });

  it('C5-1: оплата authorized на ВОЗВРАЩЁННОМ заказе → validation + message', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ status: 'refunded', paymentStatus: 'pending' })];
    const res = await setPaymentStatus({ id: UUID, to: 'authorized' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('возвращённого');
  });
});

// =============================================================================
// ДОМЕННЫЕ ОШИБКИ ДОНОСЯТ message ДО UI (OrderError extends PublicActionError).
// =============================================================================

describe('доменные ошибки → validation + message (не «internal»)', () => {
  it('getOrder: заказ не найден → validation + «Заказ не найден.»', async () => {
    // Пустая очередь getOrderById → null → OrderError('not_found').
    H.state.getOrderByIdQueue = [];
    const res = await getOrder({ id: UUID });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Заказ не найден.');
  });

  it('changeOrderStatus: заказ не найден → validation + «Заказ не найден.»', async () => {
    H.state.getOrderByIdQueue = [];
    const res = await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Заказ не найден.');
  });

  it('createPromoCode: дубликат кода (PG 23505) → validation + «уже существует»', async () => {
    // sql.begin бросает ошибку с code='23505' → isUniqueViolation → OrderError('duplicate_code').
    const dupErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    sqlBeginMock.mockImplementationOnce(async () => {
      throw dupErr;
    });
    const res = await createPromoCode({ code: 'SALE', kind: 'fixed', value: '100' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('уже существует');
  });

  it('deletePromoCode: промокод не найден → validation + «Промокод не найден.»', async () => {
    // sql`DELETE ... RETURNING id` → [] (мок по умолчанию) → OrderError('not_found').
    const res = await deletePromoCode({ id: UUID });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('Промокод не найден.');
  });
});

// =============================================================================
// РЕЗЕРВ ОСТАТКОВ ПРИ ПЕРЕХОДАХ (§6).
// =============================================================================

describe('резерв остатков при переходах', () => {
  it('отмена (paid→cancelled) вызывает releaseReservation по позиции', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid' }),
      orderDetail({ status: 'cancelled' }),
    ];
    const res = await cancelOrder({ id: UUID, reason: 'передумал' });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).toHaveBeenCalledTimes(1);
    expect(releaseReservationMock).toHaveBeenCalledWith(expect.anything(), {
      productId: 'p-1',
      variantId: null,
      qty: 2,
    });
    expect(commitReservationMock).not.toHaveBeenCalled();
  });

  it('отмена ОПЛАЧЕННОГО заказа (payment=paid) оформляет возврат: payment→refunded + история оплаты', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid', paymentStatus: 'paid' }),
      orderDetail({ status: 'cancelled', paymentStatus: 'refunded' }),
    ];
    const res = await cancelOrder({ id: UUID, reason: 'возврат денег' });
    expect(res.ok).toBe(true);
    // UPDATE orders выставил payment_status='refunded' (деньги не «зависли»).
    const upd = H.state.txCallsWithArgs.find(
      (c) => c.strings.join('|').includes('UPDATE orders') && c.strings.join('|').includes('payment_status'),
    );
    expect(upd).toBeTruthy();
    expect(upd!.args).toContain('refunded');
    // Запись истории ОПЛАТЫ (kind='payment', paid→refunded) — возврат виден в истории.
    const payHist = H.state.txCallsWithArgs.find(
      (c) => c.strings.join('|').includes('order_status_history') && c.strings.join('|').includes("'payment'"),
    );
    expect(payHist).toBeTruthy();
    expect(payHist!.args).toContain('refunded');
    expect(payHist!.args).toContain('paid');
  });

  it('V1: setPaymentStatus(→refunded) для paid-заказа в awaiting_payment СЕТТЛИТ резерв/промо/статус', async () => {
    // Заказ оплачен (payment=paid через webhook), но order.status НЕ продвинут
    // ('awaiting_payment'): canTransition('order','awaiting_payment','refunded')=false
    // → делегация выше пропускает, попадаем в fall-through. БЕЗ фикса резерв оставался
    // бы заблокирован. Проверяем, что settleRefundEffectsTx отрабатывает и тут.
    const PROMO = '22222222-2222-4222-8222-222222222222';
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'awaiting_payment', paymentStatus: 'paid' }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded' }),
    ];
    H.state.txResultQueue = [
      [{ id: 'pay' }], // 1) UPDATE payment_status RETURNING id (1 строка = успех)
      [{ id: 'hist' }], // 2) INSERT payment history
      [{ status: 'awaiting_payment', promo_code_id: PROMO }], // 3) settle: SELECT orders FOR UPDATE
      [{ product_id: 'p-1', variant_id: null, quantity: 2 }], // 4) settle: SELECT order_items
      [{ id: 'red-1' }], // 5) settle: DELETE promo_redemptions RETURNING id
    ];
    const res = await setPaymentStatus({ id: UUID, to: 'refunded' });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    // (a) Резерв освобождён по позиции снимка заказа.
    expect(releaseReservationMock).toHaveBeenCalledWith(expect.anything(), {
      productId: 'p-1',
      variantId: null,
      qty: 2,
    });
    // (b) Промокод откатан (DELETE promo_redemptions + GREATEST used_count).
    const joined = H.state.txCalls.map((s) => s.join(' ')).join('\n');
    expect(joined).toContain('promo_redemptions');
    expect(joined).toContain('used_count');
    // (c) order.status → 'refunded' + история ЗАКАЗА (kind='order'). to_status
    // 'refunded' — литерал шаблона; from ('awaiting_payment') — интерполированный арг.
    const ordHist = H.state.txCallsWithArgs.find(
      (c) => c.strings.join('|').includes('order_status_history') && c.strings.join('|').includes("'order'"),
    );
    expect(ordHist).toBeTruthy();
    expect(ordHist!.strings.join('')).toContain('refunded');
    expect(ordHist!.args).toContain('awaiting_payment');
    // И UPDATE orders SET status='refunded' прошёл (статус заказа переведён).
    const ordUpd = H.state.txCalls.map((s) => s.join(' ')).join('\n');
    expect(ordUpd).toContain("status = 'refunded'");
  });

  it('V1: идемпотентно — заказ уже cancelled → сетл no-op (без release)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'cancelled', paymentStatus: 'paid' }),
      orderDetail({ status: 'cancelled', paymentStatus: 'refunded' }),
    ];
    H.state.txResultQueue = [
      [{ id: 'pay' }], // UPDATE payment_status
      [{ id: 'hist' }], // INSERT payment history
      [{ status: 'cancelled', promo_code_id: null }], // settle SELECT → терминальный → no-op
    ];
    const res = await setPaymentStatus({ id: UUID, to: 'refunded' });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).not.toHaveBeenCalled();
  });

  it('возврат COD-заказа (payment=pending) НЕ штампует refunded и не пишет ложную историю оплаты', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid', paymentStatus: 'pending' }),
      orderDetail({ status: 'refunded', paymentStatus: 'pending' }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    // UPDATE НЕ трогает payment_status (деньги не получены — нечего возвращать).
    const updWithPay = H.state.txCallsWithArgs.find(
      (c) => c.strings.join('|').includes('UPDATE orders') && c.strings.join('|').includes('payment_status'),
    );
    expect(updWithPay).toBeFalsy();
    // Нет истории оплаты (нет запрещённого pending→refunded).
    const payHist = H.state.txCallsWithArgs.find(
      (c) => c.strings.join('|').includes('order_status_history') && c.strings.join('|').includes("'payment'"),
    );
    expect(payHist).toBeFalsy();
  });

  it('отгрузка (packed→shipped) вызывает commitReservation (списание)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'packed' }),
      orderDetail({ status: 'shipped' }),
    ];
    const res = await changeOrderStatus({ id: UUID, to: 'shipped' });
    expect(res.ok).toBe(true);
    expect(commitReservationMock).toHaveBeenCalledTimes(1);
    expect(releaseReservationMock).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------------
  // CRITICAL (волна 6, oversell): возврат/отмена УЖЕ ОТГРУЖЕННОГО заказа НЕ должен
  // дёргать releaseReservation. На входе в shipped уже выполнен commitReservation
  // (reserved-=qty), т.е. резерв ЭТОГО заказа списан. releaseReservation гардит по
  // ГЛОБАЛЬНОМУ агрегату inventory (WHERE reserved >= qty), без привязки к заказу,
  // — при наличии резерва ДРУГИХ открытых заказов на том же SKU release пройдёт и
  // украдёт ЧУЖОЙ резерв → oversell. Поэтому для from ∈ {shipped, delivered,
  // completed} эффект над резервом — 'none' (физический restock — отдельная опер.).
  // -----------------------------------------------------------------------------

  it('возврат отгруженного (shipped→refunded) НЕ вызывает release (резерв уже списан commit-ом)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'shipped', paymentStatus: 'paid' }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded' }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).not.toHaveBeenCalled();
    expect(commitReservationMock).not.toHaveBeenCalled();
  });

  it('возврат доставленного (delivered→refunded) НЕ вызывает release', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'delivered', paymentStatus: 'paid' }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded' }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).not.toHaveBeenCalled();
  });

  it('возврат завершённого (completed→refunded) НЕ вызывает release', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'completed', paymentStatus: 'paid' }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded' }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).not.toHaveBeenCalled();
  });

  it('возврат ДО отгрузки (paid→refunded) вызывает release (резерв ещё держится)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid', paymentStatus: 'paid' }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded' }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).toHaveBeenCalledTimes(1);
  });

  it('возврат из packed (packed→refunded) вызывает release (резерв ещё держится)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'packed', paymentStatus: 'paid' }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded' }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).toHaveBeenCalledTimes(1);
  });

  it('отмена НЕотгруженного (new→cancelled) вызывает release (резерв возвращается)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'new' }),
      orderDetail({ status: 'cancelled' }),
    ];
    const res = await cancelOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).toHaveBeenCalledTimes(1);
  });

  it('отмена из awaiting_payment (awaiting_payment→cancelled) вызывает release', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'awaiting_payment' }),
      orderDetail({ status: 'cancelled' }),
    ];
    const res = await cancelOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(releaseReservationMock).toHaveBeenCalledTimes(1);
  });

  // Сценарий «refund отгруженного A не уменьшает резерв B» (anti-oversell):
  // моделируем on-the-fly inventory (одна SKU). Эмулируем фактическое поведение
  // releaseReservation/commitReservation поверх состояния остатка и убеждаемся,
  // что refund заказа A из статуса shipped НЕ трогает reserved (резерв заказа B
  // сохраняется). На СТАРОМ коде stockEffectFor('refunded')='release' вызвал бы
  // releaseReservation → reserved заказа B был бы списан (украден).
  it('refund отгруженного A не уменьшает резерв B на той же SKU (anti-oversell)', async () => {
    // Состояние остатка одной SKU: после отгрузки A (3 ед.) и резерва B (4 ед.).
    // quantity=7 (10−3 commit A), reserved=4 (резерв B). available = 7−4 = 3.
    const inv = { quantity: 7, reserved: 4 };
    // Эмулируем release/commit поверх inv, чтобы поймать факт «кражи» резерва B.
    releaseReservationMock.mockImplementation(async (..._a: unknown[]) => {
      const unit = _a[1] as { qty: number };
      if (inv.reserved >= unit.qty) {
        inv.reserved -= unit.qty; // именно это «украло» бы резерв B на старом коде
        return true;
      }
      return false;
    });
    commitReservationMock.mockImplementation(async (..._a: unknown[]) => {
      const unit = _a[1] as { qty: number };
      if (inv.reserved >= unit.qty && inv.quantity >= unit.qty) {
        inv.quantity -= unit.qty;
        inv.reserved -= unit.qty;
        return true;
      }
      return false;
    });

    // Заказ A на 3 ед., из статуса shipped → refunded.
    H.state.getOrderByIdQueue = [
      {
        order: { id: UUID, number: 'GA-2026-000001', status: 'shipped', paymentStatus: 'paid', deliveryStatus: 'in_transit' },
        items: [{ productId: 'p-1', variantId: null, quantity: 3, skuSnapshot: 'SKU-1' }],
      },
      {
        order: { id: UUID, number: 'GA-2026-000001', status: 'refunded', paymentStatus: 'refunded', deliveryStatus: 'in_transit' },
        items: [{ productId: 'p-1', variantId: null, quantity: 3, skuSnapshot: 'SKU-1' }],
      },
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    // Резерв заказа B (4 ед.) НЕ тронут — release не вызывался (дефолтные
    // реализации release/commit реинсталлируются в afterEach — изоляция).
    expect(inv.reserved).toBe(4);
    expect(releaseReservationMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GUARDED UPDATE / TOCTOU-ГОНКА СТАТУСА (Fix 1, §2.8).
//
// Юнит-уровень: проверяем, что (а) UPDATE статуса несёт guard `AND status = from`,
// (б) при affected rows ≠ 1 (конкурентный переход) action отдаёт конфликт и НЕ
// пишет историю/побочные эффекты. Полная конкурентность (2 параллельных перехода
// на живой БД) валидируется интеграционным тестом в repository.test.ts (нужна БД).
// =============================================================================

describe('guarded UPDATE статуса (TOCTOU)', () => {
  /** Был ли среди tx-запросов guarded UPDATE по нужной колонке (`AND <col> =`). */
  function hasGuard(col: string): boolean {
    return H.state.txCalls.some((tpl) => tpl.join('|').includes(`AND ${col} =`));
  }
  /** Был ли INSERT в order_status_history среди tx-запросов. */
  function wroteHistory(): boolean {
    return H.state.txCalls.some((tpl) => tpl.join('|').includes('order_status_history'));
  }

  it('order: UPDATE несёт guard «AND status =» (happy-path new→paid)', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ status: 'new' }), orderDetail({ status: 'paid' })];
    const res = await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(true);
    expect(hasGuard('status')).toBe(true);
    expect(wroteHistory()).toBe(true);
  });

  it('order: конкурентный переход (guarded UPDATE 0 строк) → conflict, история НЕ пишется', async () => {
    // Первый tx-запрос (guarded UPDATE) вернёт [] → affected rows = 0 → конфликт.
    H.state.getOrderByIdQueue = [orderDetail({ status: 'new' })];
    H.state.txResultQueue = [[]];
    const res = await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation'); // OrderError('conflict') → PublicActionError
    expect(res.message).toContain('изменился параллельно');
    expect(wroteHistory()).toBe(false);
    expect(releaseReservationMock).not.toHaveBeenCalled();
    expect(commitReservationMock).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it('payment: UPDATE несёт guard «AND payment_status =» (happy-path pending→paid)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ paymentStatus: 'pending' }),
      orderDetail({ paymentStatus: 'paid' }),
    ];
    const res = await setPaymentStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(true);
    expect(hasGuard('payment_status')).toBe(true);
    expect(wroteHistory()).toBe(true);
  });

  it('payment: конкурентный переход (0 строк) → conflict, история НЕ пишется', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ paymentStatus: 'pending' })];
    H.state.txResultQueue = [[]];
    const res = await setPaymentStatus({ id: UUID, to: 'paid' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('изменился параллельно');
    expect(wroteHistory()).toBe(false);
  });

  it('delivery: UPDATE несёт guard «AND delivery_status =» (happy-path pending→registered)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ deliveryStatus: 'pending' }),
      orderDetail({ deliveryStatus: 'registered' }),
    ];
    const res = await setDeliveryStatus({ id: UUID, to: 'registered' });
    expect(res.ok).toBe(true);
    expect(hasGuard('delivery_status')).toBe(true);
    expect(wroteHistory()).toBe(true);
  });

  it('delivery: конкурентный переход (0 строк) → conflict, история НЕ пишется', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ deliveryStatus: 'pending' })];
    H.state.txResultQueue = [[]];
    const res = await setDeliveryStatus({ id: UUID, to: 'registered' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('изменился параллельно');
    expect(wroteHistory()).toBe(false);
  });
});

// =============================================================================
// ОТКАТ ПРОМОКОДА ПРИ ОТМЕНЕ/ВОЗВРАТЕ (Fix 4, §5.2).
// =============================================================================

describe('откат used_count/promo_redemptions при cancel/refund', () => {
  const PROMO_ID = '22222222-2222-4222-8222-222222222222';

  /** Все статические куски tx-запросов одной плоской строкой (для поиска DELETE/UPDATE). */
  function txText(): string {
    return H.state.txCalls.map((tpl) => tpl.join('|')).join('||');
  }

  it('cancel с promoCodeId: DELETE promo_redemptions + UPDATE used_count (редемпшн удалён)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid', promoCodeId: PROMO_ID }),
      orderDetail({ status: 'cancelled', promoCodeId: PROMO_ID }),
    ];
    // Порядок tx-запросов: guarded UPDATE orders → DELETE promo_redemptions → UPDATE promo_codes → INSERT history.
    // Дефолт DEFAULT_TX_ROW (1 строка) подойдёт для всех (guarded UPDATE ok; DELETE «удалил» 1).
    const res = await cancelOrder({ id: UUID });
    expect(res.ok).toBe(true);
    const text = txText();
    expect(text).toContain('DELETE FROM promo_redemptions');
    expect(text).toContain('used_count = GREATEST');
  });

  it('refund с promoCodeId: тоже откатывает (DELETE + GREATEST used_count − N)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'delivered', paymentStatus: 'paid', promoCodeId: PROMO_ID }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded', promoCodeId: PROMO_ID }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    const text = txText();
    expect(text).toContain('DELETE FROM promo_redemptions');
    expect(text).toContain('used_count = GREATEST');
  });

  it('cancel без promoCodeId: откат НЕ выполняется (нет DELETE/used_count)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid', promoCodeId: null }),
      orderDetail({ status: 'cancelled', promoCodeId: null }),
    ];
    const res = await cancelOrder({ id: UUID });
    expect(res.ok).toBe(true);
    const text = txText();
    expect(text).not.toContain('promo_redemptions');
    expect(text).not.toContain('used_count');
  });

  it('cancel: повторный откат идемпотентен — DELETE вернул 0 строк → used_count НЕ трогаем', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid', promoCodeId: PROMO_ID }),
      orderDetail({ status: 'cancelled', promoCodeId: PROMO_ID }),
    ];
    // tx-результаты по порядку: [1] guarded UPDATE orders → ok (1 строка),
    // [2] DELETE promo_redemptions → [] (редемпшн уже откачен ранее).
    // Тогда UPDATE used_count выполняться НЕ должен.
    H.state.txResultQueue = [[{ id: 'tx-row-id' }], []];
    const res = await cancelOrder({ id: UUID });
    expect(res.ok).toBe(true);
    const text = txText();
    expect(text).toContain('DELETE FROM promo_redemptions');
    expect(text).not.toContain('used_count');
  });

  it('shipped (commit) с promoCodeId: откат НЕ выполняется (только cancel/refund откатывают)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'packed', promoCodeId: PROMO_ID }),
      orderDetail({ status: 'shipped', promoCodeId: PROMO_ID }),
    ];
    const res = await changeOrderStatus({ id: UUID, to: 'shipped' });
    expect(res.ok).toBe(true);
    const text = txText();
    expect(text).not.toContain('promo_redemptions');
    expect(text).not.toContain('used_count');
  });
});

// =============================================================================
// AUDIT (формирование записи).
// =============================================================================

describe('аудит-запись', () => {
  it('changeOrderStatus пишет audit order.status.change с before/after', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ status: 'new' }), orderDetail({ status: 'paid' })];
    await changeOrderStatus({ id: UUID, to: 'paid' });
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const [entry] = writeAuditSpy.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({
      action: 'order.status.change',
      entityType: 'order',
      entityId: UUID,
      before: { status: 'new' },
      after: { status: 'paid' },
    });
  });

  it('cancelOrder пишет audit order.cancel', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'new' }),
      orderDetail({ status: 'cancelled' }),
    ];
    await cancelOrder({ id: UUID });
    const [entry] = writeAuditSpy.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({ action: 'order.cancel', entityId: UUID });
  });

  it('недопустимый переход → audit НЕ пишется', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ status: 'new' })];
    await changeOrderStatus({ id: UUID, to: 'shipped' });
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// ПРОМОКОДЫ — Zod-валидация + аудит promo.*.
// =============================================================================

describe('промокоды: валидация и аудит', () => {
  it('createPromoCode: percent value > 100 → validation', async () => {
    const res = await createPromoCode({ code: 'BIG', kind: 'percent', value: '150' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });

  it('createPromoCode: пустой код → validation', async () => {
    const res = await createPromoCode({ code: '', kind: 'fixed', value: '100' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });

  it('updatePromoCode: bogo pay_qty >= buy_qty → validation', async () => {
    const res = await updatePromoCode({
      id: UUID,
      kind: 'bogo',
      bogoBuyQty: 2,
      bogoPayQty: 3,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });

  it('deletePromoCode требует orders.write → forbidden без права', async () => {
    H.state.currentUser = makeUser(['orders.read']);
    const res = await deletePromoCode({ id: UUID });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('deactivatePromoCode: невалидный id → validation', async () => {
    const res = await deactivatePromoCode({ id: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });
});

// =============================================================================
// PARTIAL-UPDATE ПРОМОКОДА: дефолты НЕ затирают существующие значения (баги #17/#18).
//
// Регресс: PromoUpdateSchema строилась как .partial() поверх схемы с .default(...).
// При partial-update (передан только один-два поля) Zod подставлял DEFAULT для
// опущенных ключей (value→'0', isActive→true, comment→'', applyScope→'cart',
// priority→100, stackable→false, targets→[]), а handler писал их в БД через
// COALESCE(${default}, col) — затирая реальные значения. Плюс applyScope='cart'
// делал manageTargets=true → DELETE promo_targets даже без передачи targets.
//
// Юнит-уровень: проверяем интерполированные аргументы UPDATE-запроса и факт
// (не)выполнения DELETE/INSERT promo_targets. БД не дёргается (мок tx).
// =============================================================================

describe('partial-update промокода: дефолты не затирают данные (#17/#18)', () => {
  /** Перед UPDATE action делает SELECT promo_codes (sql`...`), отдаём непустую строку. */
  function seedExistingPromo() {
    // updatePromoCode сначала SELECT через sql`...` — мок sql по умолчанию [] →
    // OrderError('not_found'). Подменяем мок sql, чтобы первый вызов вернул строку.
    // Проще: используем txResultQueue только для tx; SELECT идёт через sql (не tx).
    // sql-мок возвращает [] всегда → нужно вернуть строку. Делаем это локально.
  }
  void seedExistingPromo;

  /** Находит интерполированные аргументы tx-запроса UPDATE promo_codes. */
  function findUpdateArgs(): unknown[] | undefined {
    const call = H.state.txCallsWithArgs.find((c) =>
      c.strings.join('|').includes('UPDATE promo_codes'),
    );
    return call?.args;
  }

  /** Был ли среди tx-запросов DELETE FROM promo_targets. */
  function deletedTargets(): boolean {
    return H.state.txCalls.some((tpl) => tpl.join('|').includes('DELETE FROM promo_targets'));
  }

  /** Был ли INSERT в promo_targets среди tx-запросов. */
  function insertedTargets(): boolean {
    return H.state.txCalls.some((tpl) => tpl.join('|').includes('INSERT INTO promo_targets'));
  }

  it('#17: частичный апдейт (только code) не затирает value/minOrderTotal/isActive/comment/priority/stackable дефолтами', async () => {
    // SELECT существующего промокода (sql`...`) → возвращаем строку.
    sqlMock.mockImplementationOnce(() => Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'cart' }]));

    const res = await updatePromoCode({ id: UUID, code: 'NEWCODE' });
    expect(res.ok).toBe(true);

    const args = findUpdateArgs();
    expect(args, 'UPDATE promo_codes должен выполниться').toBeDefined();
    const a = args!;
    // Позиции COALESCE-аргументов в UPDATE (см. lib/orders/actions.ts):
    //  [0]=code [2]=value [3]=minOrderTotal [14]=isActive
    //  [19]=applyScope [20]=priority [21]=stackable [30]=comment.
    // Опущенные поля должны прийти как null (COALESCE сохраняет колонку в БД),
    // а НЕ как дефолт ('0' / true / '' / 'cart' / 100 / false).
    expect(a[0]).toBe('NEWCODE'); // code — единственное переданное
    expect(a[2]).toBeNull(); // value: не дефолт '0'
    expect(a[3]).toBeNull(); // minOrderTotal: не дефолт '0'
    expect(a[14]).toBeNull(); // isActive: не дефолт true
    expect(a[19]).toBeNull(); // applyScope: не дефолт 'cart'
    expect(a[20]).toBeNull(); // priority: не дефолт 100
    expect(a[21]).toBeNull(); // stackable: не дефолт false
    expect(a[30]).toBeNull(); // comment: не дефолт ''
  });

  it('#18: частичный апдейт без targets не трогает promo_targets (нет DELETE/INSERT)', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'category' }]),
    );

    const res = await updatePromoCode({ id: UUID, value: '500' });
    expect(res.ok).toBe(true);

    // applyScope не передан → manageTargets должен быть false → таргеты не трогаем.
    expect(deletedTargets()).toBe(false);
    expect(insertedTargets()).toBe(false);
  });

  it('#18: явный перевод scope в cart всё ещё чистит таргеты (DELETE без INSERT)', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'category' }]),
    );

    const res = await updatePromoCode({ id: UUID, applyScope: 'cart' });
    expect(res.ok).toBe(true);

    expect(deletedTargets()).toBe(true);
    expect(insertedTargets()).toBe(false); // targets пуст → ничего не вставляем
  });

  it('передача targets при scope=category пересоздаёт таргеты (DELETE + INSERT)', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'category' }]),
    );

    const res = await updatePromoCode({
      id: UUID,
      applyScope: 'category',
      targets: [{ targetType: 'category', categoryId: UUID }],
    });
    expect(res.ok).toBe(true);

    expect(deletedTargets()).toBe(true);
    expect(insertedTargets()).toBe(true);
  });

  it('явный апдейт value/comment/isActive проходит в UPDATE как переданные значения', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'cart' }]),
    );

    const res = await updatePromoCode({
      id: UUID,
      value: '250',
      comment: 'летняя акция',
      isActive: false,
    });
    expect(res.ok).toBe(true);

    const args = findUpdateArgs();
    expect(args).toBeDefined();
    const a = args!;
    expect(a[2]).toBe('250'); // value передан явно (позиция COALESCE value)
    expect(a[14]).toBe(false); // isActive=false передан явно (позиция COALESCE is_active)
    expect(a[30]).toBe('летняя акция'); // comment передан явно (позиция COALESCE comment)
  });

  it('#1-регресс: targets:[] у scoped-промокода (scope не передан) → отказ, таргеты НЕ трогаем', async () => {
    // Текущий scope в БД = 'category', запрос {id, targets:[]} без applyScope.
    // Очистка целей оставила бы scope='category' с 0 целей (мёртвый промокод) →
    // должен быть отказ validation, без UPDATE/DELETE.
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'category' }]),
    );

    const res = await updatePromoCode({ id: UUID, targets: [] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('цель');
    expect(findUpdateArgs(), 'UPDATE не должен выполниться').toBeUndefined();
    expect(deletedTargets()).toBe(false);
  });

  it('#1-регресс: targets:[] + явный applyScope=cart → разрешено (перевод в cart + очистка)', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'category' }]),
    );

    const res = await updatePromoCode({ id: UUID, applyScope: 'cart', targets: [] });

    expect(res.ok).toBe(true);
    expect(deletedTargets()).toBe(true); // scope=cart → цели чистим, это валидно
    expect(insertedTargets()).toBe(false);
  });

  // ===========================================================================
  // БАГ #3 (data-integrity): частичный апдейт value у percent-промокода обходит
  // проверку 0..100. refinePromo проверяет диапазон ТОЛЬКО когда в payload есть и
  // kind, и value. При {id, value:'150'} (kind не передан, в БД kind='percent')
  // значение >100% попадало в БД → скидка >100%. Фикс — в handler по
  // ЭФФЕКТИВНОМУ kind (data.kind ?? before.kind) + ЭФФЕКТИВНОМУ value.
  // ===========================================================================

  it('#3: частичный value=150 при kind=percent в БД → validation (UPDATE не выполняется)', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'cart', kind: 'percent', value: '10' }]),
    );

    const res = await updatePromoCode({ id: UUID, value: '150' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('0..100');
    expect(findUpdateArgs(), 'UPDATE не должен выполниться').toBeUndefined();
  });

  it('#3: смена kind→fixed с value=150 → ок (fixed без верхней границы)', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'cart', kind: 'percent', value: '10' }]),
    );

    const res = await updatePromoCode({ id: UUID, kind: 'fixed', value: '150' });

    expect(res.ok).toBe(true);
    const args = findUpdateArgs();
    expect(args).toBeDefined();
    expect(args![2]).toBe('150'); // value прошёл как есть
  });

  it('#3: частичный value=100 при kind=percent в БД → ок (граница включительно)', async () => {
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'cart', kind: 'percent', value: '10' }]),
    );

    const res = await updatePromoCode({ id: UUID, value: '100' });

    expect(res.ok).toBe(true);
    const args = findUpdateArgs();
    expect(args).toBeDefined();
    expect(args![2]).toBe('100');
  });

  it('#3: явная смена kind→percent с value=120 → validation', async () => {
    // Здесь в payload есть И kind, И value → refinePromo ловит percent>100 уже на
    // Zod-уровне (до handler). Пайплайн отдаёт error:'validation' (message Zod-issue
    // не выносит в res.message). UPDATE не выполняется.
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'cart', kind: 'fixed', value: '50' }]),
    );

    const res = await updatePromoCode({ id: UUID, kind: 'percent', value: '120' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(findUpdateArgs()).toBeUndefined();
  });

  it('#3: смена kind percent→fixed без value (берём value из БД) → ок, проверка percent не срабатывает', async () => {
    // В БД value='150', kind='percent'. Меняем только kind→fixed. Эффективный
    // kind=fixed → проверка percent не применяется, апдейт проходит.
    sqlMock.mockImplementationOnce(() =>
      Promise.resolve([{ id: UUID, code: 'OLD', apply_scope: 'cart', kind: 'percent', value: '150' }]),
    );

    const res = await updatePromoCode({ id: UUID, kind: 'fixed' });

    expect(res.ok).toBe(true);
    expect(findUpdateArgs()).toBeDefined();
  });
});

// =============================================================================
// РУЧНОЕ СОЗДАНИЕ ЗАКАЗА (createManualOrder → repository.createOrder с source='admin').
// =============================================================================

describe('createManualOrder', () => {
  const manualInput = {
    items: [{ productId: UUID, qty: 1 }],
    customer: { name: 'Иван', email: 'i@shop.io', phone: '+70000000000' },
    delivery: { type: 'pickup' as const },
    paymentMethod: 'cod' as const,
  };

  it('требует orders.write → forbidden с orders.read', async () => {
    H.state.currentUser = makeUser(['orders.read']);
    const res = await createManualOrder(manualInput);
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('вызывает createOrder с source=admin и пишет audit order.create.manual', async () => {
    const res = await createManualOrder(manualInput);
    expect(res.ok).toBe(true);
    expect(createOrderMock).toHaveBeenCalledTimes(1);
    const [, ctxArg] = createOrderMock.mock.calls[0] as [unknown, { source?: string }];
    expect(ctxArg.source).toBe('admin');
    const [entry] = writeAuditSpy.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({ action: 'order.create.manual', entityType: 'order' });
  });

  it('createOrder вернул out_of_stock → validation + message (OrderError доносит текст)', async () => {
    createOrderMock.mockResolvedValueOnce({
      ok: false,
      code: 'out_of_stock',
      message: 'нет остатка',
    } as never);
    const res = await createManualOrder(manualInput);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBe('нет остатка');
  });
});

// =============================================================================
// ШЛЮЗОВОЙ ВОЗВРАТ Т-БАНКА В refundOrder (Фича #15).
//
// refundOrder ДО смены статуса вызывает PaymentService.refundPayment (вернуть деньги
// через Т-Банк Cancel). Инвариант «двойного сетла нет»: метод НЕ меняет payment_status
// — внутренний сетл делает applyOrderStatusTransition. При провале шлюза (ok:false)
// переход НЕ выполняется (не врём про refunded).
// =============================================================================

describe('refundOrder: шлюзовой возврат Т-Банка', () => {
  type RefundAudit = {
    action: string;
    after: { gatewayRefund?: { status: string | null; skipped: boolean; isMock: boolean } };
  };

  it('paid+tbank: refundPayment вызван ДО перехода; переход выполняется; audit несёт gatewayRefund', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({
        status: 'paid',
        paymentStatus: 'paid',
        paymentProvider: 'tbank',
        paymentRef: 'mock-pay-1',
        grandTotal: '1000.00',
      }),
      orderDetail({ status: 'refunded', paymentStatus: 'refunded', paymentProvider: 'tbank' }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    // Шлюз вызван ровно раз с корректными (серверными) суммами/реквизитами.
    expect(refundPaymentMock).toHaveBeenCalledTimes(1);
    const arg = refundPaymentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      paymentProvider: 'tbank',
      paymentStatus: 'paid',
      paymentRef: 'mock-pay-1',
      amountKop: 100000, // 1000.00 ₽ → копейки (считает сервер, не запрос)
    });
    // refundPayment вызван РАНЬШЕ транзакции перехода (sql.begin).
    expect(refundPaymentMock.mock.invocationCallOrder[0]!).toBeLessThan(
      sqlBeginMock.mock.invocationCallOrder[0]!,
    );
    // Переход выполнен: резерв освобождён (paid→refunded, резерв ещё держится).
    expect(releaseReservationMock).toHaveBeenCalledTimes(1);
    // Аудит несёт трассировку шлюза.
    const [entry] = writeAuditSpy.mock.calls[0] as [RefundAudit];
    expect(entry.action).toBe('order.refund');
    expect(entry.after.gatewayRefund).toMatchObject({ status: 'REFUNDED', skipped: false });
  });

  it('refundRes.ok=false: переход НЕ выполняется, возвращается ошибка, release/audit НЕ пишутся', async () => {
    refundPaymentMock.mockResolvedValueOnce({
      ok: false,
      status: null,
      isMock: false,
      reason: 'cancel_failed',
    });
    H.state.getOrderByIdQueue = [
      orderDetail({
        status: 'paid',
        paymentStatus: 'paid',
        paymentProvider: 'tbank',
        paymentRef: 'mock-pay-1',
        grandTotal: '1000.00',
      }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('платёжный шлюз');
    // Деньги не вернулись → НЕ помечаем заказ refunded (нет транзакции/эффектов).
    expect(sqlBeginMock).not.toHaveBeenCalled();
    expect(releaseReservationMock).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it('ФИКС1: невалидный переход (order.status=new) → шлюз refundPayment НЕ зовётся, invalid_transition', async () => {
    // Заказ authorized + статус new (откуда refunded недопустим). БЕЗ предпроверки
    // refundPayment сделал бы REVERSED (холд снят в банке), а потом переход упал бы →
    // деньги отпущены, заказ не refunded. Предпроверка перехода ДО шлюза это закрывает.
    H.state.getOrderByIdQueue = [
      orderDetail({
        status: 'new',
        paymentStatus: 'authorized',
        paymentProvider: 'tbank',
        paymentRef: 'mock-pay-1',
        grandTotal: '1000.00',
      }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('Недопустимый переход статуса заказа');
    // Шлюз НЕ дёргался (холд/деньги не тронуты) и транзакция перехода не открывалась.
    expect(refundPaymentMock).not.toHaveBeenCalled();
    expect(sqlBeginMock).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it('COD/manual (provider!=tbank): refundPayment вернул skipped → переход всё равно идёт', async () => {
    refundPaymentMock.mockResolvedValueOnce({
      ok: true,
      status: null,
      isMock: true,
      skipped: true,
      reason: 'no_gateway',
    });
    H.state.getOrderByIdQueue = [
      orderDetail({ status: 'paid', paymentStatus: 'pending', paymentProvider: null, grandTotal: '500.00' }),
      orderDetail({ status: 'refunded', paymentStatus: 'pending', paymentProvider: null }),
    ];
    const res = await refundOrder({ id: UUID });
    expect(res.ok).toBe(true);
    expect(refundPaymentMock).toHaveBeenCalledTimes(1);
    const arg = refundPaymentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.paymentProvider).toBeNull();
    // Внутренний сетл всё равно отработал: резерв paid→refunded освобождён.
    expect(releaseReservationMock).toHaveBeenCalledTimes(1);
  });
});
