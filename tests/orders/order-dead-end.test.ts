import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ЮНИТ-тесты выхода из ДВУХ тупиков заказа (аудит 2026-07-26, находки #8 и #9).
 * БЕЗ БД/Next — зависимости изолированы vi.mock-ами (как tests/orders/actions.test.ts).
 *
 * C1 (#8) — оплаченный заказ с «неудобным» телефоном не отгрузить, а исправить
 *           контакты в админке нечем: появляется updateOrderContact (orders.write,
 *           аудит, история). Вход на витрине НЕ ужесточаем до российского формата —
 *           магазин трёхъязычный (см. tests/orders/phone.test.ts).
 * C2 (#9) — удалённый вариант уносит резерв, и заказ навсегда застревает перед
 *           «Отгружен»: commitReservation отдаёт false → commit_failed → ROLLBACK.
 *           Выход — осознанная отгрузка БЕЗ списания остатка (forceStockCommit),
 *           только с комментарием-обоснованием, с пометкой в истории и аудите.
 */

// --- управляемое состояние моков ---------------------------------------------

const H = vi.hoisted(() => {
  interface SqlCall {
    text: string;
    args: unknown[];
  }
  const state = {
    currentUser: null as AuthUser | null,
    getOrderByIdQueue: [] as unknown[],
    /** Результаты запросов ВНУТРИ транзакции (первый — guarded UPDATE). */
    txResultQueue: [] as unknown[][],
    txCalls: [] as SqlCall[],
    /** Результаты запросов ВНЕ транзакции (sql`...`), по порядку. */
    sqlResultQueue: [] as unknown[][],
    sqlCalls: [] as SqlCall[],
  };
  const DEFAULT_TX_ROW = [{ id: 'tx-row-id' }];

  function text(strings: TemplateStringsArray | string[]): string {
    return Array.from(strings).join('?');
  }

  const sqlBeginMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray, ...args: unknown[]) => {
      state.txCalls.push({ text: text(strings), args });
      const next = state.txResultQueue.length > 0 ? state.txResultQueue.shift()! : DEFAULT_TX_ROW;
      return Promise.resolve(next);
    };
    (tx as unknown as { json: unknown }).json = (v: unknown) => v;
    return cb(tx);
  });

  const sqlMock = vi.fn((strings: TemplateStringsArray, ...args: unknown[]) => {
    state.sqlCalls.push({ text: text(strings), args });
    const next = state.sqlResultQueue.length > 0 ? state.sqlResultQueue.shift()! : [];
    return Promise.resolve(next);
  });
  (sqlMock as unknown as { begin: unknown }).begin = sqlBeginMock;
  (sqlMock as unknown as { json: unknown }).json = (v: unknown) => v;

  return {
    state,
    sqlMock,
    sqlBeginMock,
    writeAuditSpy: vi.fn(async (..._args: unknown[]) => {}),
    getCurrentUserMock: vi.fn(async () => state.currentUser),
    getOrderByIdMock: vi.fn(async (..._args: unknown[]) => state.getOrderByIdQueue.shift() ?? null),
    releaseReservationMock: vi.fn(async (..._args: unknown[]) => true),
    commitReservationMock: vi.fn(async (..._args: unknown[]) => true),
    createOrderMock: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
    autoIssueMock: vi.fn(async (..._args: unknown[]) => ({})),
  };
});

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: H.getCurrentUserMock }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (...args: unknown[]) => H.writeAuditSpy(...(args as [])),
}));
vi.mock('@/lib/config/settings', () => ({ isModuleEffectivelyEnabled: async () => true }));
vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));
vi.mock('@/lib/gift-certificates/auto-issue', () => ({
  autoIssueGiftsForPaidOrder: (id: string) => H.autoIssueMock(id),
}));
vi.mock('@/lib/orders/repository', () => ({
  getOrderById: H.getOrderByIdMock,
  releaseReservation: H.releaseReservationMock,
  commitReservation: H.commitReservationMock,
  createOrder: H.createOrderMock,
  mapOrder: (r: unknown) => r,
  mapOrderItem: (r: unknown) => r,
}));
vi.mock('@/lib/payments/tbank', () => ({
  PaymentService: class {
    refundPayment() {
      return Promise.resolve({ ok: true, status: 'REFUNDED', isMock: true, skipped: false });
    }
  },
  toKopecks: (v: string | number) => Math.round(Number(v) * 100),
}));
vi.mock('@/lib/payments/paykeeper', () => ({
  PaymentService: class {
    refundPayment() {
      return Promise.resolve({ ok: true, status: null, isMock: true, skipped: true });
    }
  },
}));

// Импорт actions ПОСЛЕ моков.
import { changeOrderStatus, updateOrderContact } from '@/lib/orders/actions';

// --- хелперы -----------------------------------------------------------------

function makeUser(perms: PermissionCode[]): AuthUser {
  return {
    id: 'u-1',
    email: 'manager@shop.io',
    isOwner: false,
    permissions: new Set<PermissionCode>(perms),
  };
}

const UUID = '11111111-1111-4111-8111-111111111111';

function orderDetail(over: Record<string, unknown> = {}) {
  return {
    order: {
      id: UUID,
      number: 'GA-2026-000001',
      status: 'packed',
      paymentStatus: 'paid',
      deliveryStatus: 'pending',
      deliveryType: 'pvz',
      deliveryCity: 'Москва',
      deliveryAddress: null,
      deliveryPvzCode: 'MSK1',
      customerName: 'Иван',
      customerEmail: 'i@shop.io',
      customerPhone: '2223344',
      cdekUuid: null,
      promoCodeId: null,
      ...over,
    },
    items: [{ productId: 'p-1', variantId: null, quantity: 1, skuSnapshot: 'SKU-1' }],
  };
}

/** Все sql/tx-вызовы одной строкой — для поиска фрагментов запросов. */
function allSql(): string {
  return [...H.state.sqlCalls, ...H.state.txCalls].map((c) => c.text).join('||');
}

function txCall(match: string) {
  return H.state.txCalls.find((c) => c.text.includes(match));
}

function auditEntry(): Record<string, unknown> | undefined {
  const call = H.writeAuditSpy.mock.calls.at(-1);
  return call?.[0] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  H.state.currentUser = makeUser(['orders.read', 'orders.write']);
  H.state.getOrderByIdQueue = [];
  H.state.txResultQueue = [];
  H.state.txCalls = [];
  H.state.sqlResultQueue = [];
  H.state.sqlCalls = [];
  H.sqlMock.mockClear();
  H.sqlBeginMock.mockClear();
  H.writeAuditSpy.mockClear();
  H.getOrderByIdMock.mockClear();
  H.commitReservationMock.mockClear();
  H.releaseReservationMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
  H.releaseReservationMock.mockImplementation(async () => true);
  H.commitReservationMock.mockImplementation(async () => true);
});

// =============================================================================
// C1 (#8) — updateOrderContact: правка контактов оплаченного заказа.
// =============================================================================

describe('C1 updateOrderContact — права и валидация', () => {
  const base = {
    id: UUID,
    customerName: 'Иван Петров',
    customerEmail: 'i@shop.io',
    customerPhone: '+7 912 345-67-89',
  };

  it('без orders.write → forbidden (правка контактов = мутация)', async () => {
    H.state.currentUser = makeUser(['orders.read']);
    const res = await updateOrderContact(base);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
    expect(allSql()).not.toContain('UPDATE orders');
  });

  it('телефон без цифр отклоняется валидацией (fieldErrors)', async () => {
    H.state.getOrderByIdQueue = [orderDetail()];
    const res = await updateOrderContact({ ...base, customerPhone: '---' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors?.customerPhone?.length).toBeGreaterThan(0);
    expect(allSql()).not.toContain('UPDATE orders');
  });

  it('ИНОСТРАННЫЙ телефон принимается: СДЭК возит по РФ, но магазин трёхъязычный', async () => {
    H.state.getOrderByIdQueue = [orderDetail(), orderDetail({ customerPhone: '+33612345678' })];
    const res = await updateOrderContact({ ...base, customerPhone: '+33 6 12 34 56 78' });
    expect(res.ok).toBe(true);
  });

  it('несуществующий заказ → доменный отказ, UPDATE не выполняется', async () => {
    H.state.getOrderByIdQueue = [];
    const res = await updateOrderContact(base);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
    expect(allSql()).not.toContain('UPDATE orders');
  });

  it('терминальный заказ (refunded) не редактируется — история не переписывается', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ status: 'refunded' })];
    const res = await updateOrderContact(base);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('conflict');
    expect(allSql()).not.toContain('UPDATE orders');
  });

  it('курьерская доставка без адреса — отказ (иначе накладную снова не создать)', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail({ deliveryType: 'courier', deliveryAddress: 'ул. Ленина, 1' }),
    ];
    const res = await updateOrderContact({ ...base, deliveryAddress: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('invalid_address');
  });
});

describe('C1 updateOrderContact — успешная правка', () => {
  it('пишет контакты и адрес одним UPDATE и фиксирует аудит с before/after', async () => {
    H.state.getOrderByIdQueue = [
      orderDetail(),
      orderDetail({ customerPhone: '+79123456789', customerName: 'Иван Петров' }),
    ];
    const res = await updateOrderContact({
      id: UUID,
      customerName: 'Иван Петров',
      customerEmail: 'i@shop.io',
      customerPhone: '+7 912 345-67-89',
      deliveryCity: 'Москва',
      deliveryAddress: 'ул. Ленина, 1',
      reason: 'покупатель прислал верный номер',
    });
    expect(res.ok).toBe(true);

    const update = [...H.state.sqlCalls, ...H.state.txCalls].find((c) =>
      c.text.includes('UPDATE orders'),
    );
    expect(update).toBeDefined();
    expect(update!.text).toContain('customer_phone');
    expect(update!.text).toContain('customer_name');
    expect(update!.text).toContain('customer_email');
    expect(update!.text).toContain('delivery_address');
    expect(update!.args).toContain('+7 912 345-67-89');

    const entry = auditEntry();
    expect(entry?.action).toBe('order.contact.update');
    expect(entry?.entityId).toBe(UUID);
    expect((entry?.before as Record<string, unknown>)?.customerPhone).toBe('2223344');
    expect((entry?.after as Record<string, unknown>)?.customerPhone).toBe('+7 912 345-67-89');
  });

  it('сообщает, что накладная СДЭК уже создана (менять данные надо и в СДЭК)', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ cdekUuid: 'cdek-1' }), orderDetail()];
    const res = await updateOrderContact({
      id: UUID,
      customerName: 'Иван',
      customerEmail: 'i@shop.io',
      customerPhone: '89123456789',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { cdekShipmentExists: boolean }).cdekShipmentExists).toBe(true);
  });

  it('конкурентное закрытие заказа: guarded UPDATE даёт 0 строк → конфликт, история не пишется', async () => {
    H.state.getOrderByIdQueue = [orderDetail()];
    H.state.txResultQueue = [[]]; // UPDATE ... AND status NOT IN (...) не нашёл строку
    const res = await updateOrderContact({
      id: UUID,
      customerName: 'Иван',
      customerEmail: 'i@shop.io',
      customerPhone: '89123456789',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('conflict');
    expect(txCall('order_status_history')).toBeUndefined();
  });

  it('пишет запись в историю заказа (правка видна оператору, а не только в аудите)', async () => {
    H.state.getOrderByIdQueue = [orderDetail(), orderDetail()];
    await updateOrderContact({
      id: UUID,
      customerName: 'Иван',
      customerEmail: 'i@shop.io',
      customerPhone: '89123456789',
      reason: 'уточнили телефон',
    });
    expect(allSql()).toContain('order_status_history');
  });
});

// =============================================================================
// C2 (#9) — отгрузка заказа с потерянным резервом (удалённый вариант).
// =============================================================================

describe('C2 отгрузка при недоступном остатке', () => {
  it('без force: отказ с машиночитаемым кодом commit_failed и откатом', async () => {
    H.state.getOrderByIdQueue = [orderDetail()];
    H.commitReservationMock.mockImplementation(async () => false);

    const res = await changeOrderStatus({ id: UUID, to: 'shipped' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('commit_failed');
      expect(res.message).toContain('SKU-1');
    }
    // История не пишется — транзакция откатилась.
    expect(txCall('order_status_history')).toBeUndefined();
  });

  it('force без комментария-обоснования отклоняется валидацией', async () => {
    H.state.getOrderByIdQueue = [orderDetail()];
    H.commitReservationMock.mockImplementation(async () => false);

    const res = await changeOrderStatus({ id: UUID, to: 'shipped', forceStockCommit: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors?.comment?.length).toBeGreaterThan(0);
    expect(H.sqlBeginMock).not.toHaveBeenCalled();
  });

  it('force с комментарием: переход проходит, SKU попадает в историю и аудит', async () => {
    H.state.getOrderByIdQueue = [orderDetail(), orderDetail({ status: 'shipped' })];
    H.commitReservationMock.mockImplementation(async () => false);

    const res = await changeOrderStatus({
      id: UUID,
      to: 'shipped',
      comment: 'вариант удалён из каталога, остаток списан вручную',
      forceStockCommit: true,
    });
    expect(res.ok).toBe(true);

    const history = txCall('order_status_history');
    expect(history).toBeDefined();
    const comment = history!.args.find((a) => typeof a === 'string' && a.includes('SKU-1'));
    expect(comment).toBeDefined();

    const entry = auditEntry();
    expect(entry?.action).toBe('order.status.change');
    expect((entry?.after as Record<string, unknown>)?.forcedStockCommit).toEqual(['SKU-1']);
  });

  it('force НЕ обходит guarded UPDATE: конкурентная смена статуса → conflict', async () => {
    H.state.getOrderByIdQueue = [orderDetail()];
    H.state.txResultQueue = [[]]; // guarded UPDATE затронул 0 строк
    H.commitReservationMock.mockImplementation(async () => false);

    const res = await changeOrderStatus({
      id: UUID,
      to: 'shipped',
      comment: 'форс',
      forceStockCommit: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('conflict');
    expect(H.commitReservationMock).not.toHaveBeenCalled();
    expect(txCall('order_status_history')).toBeUndefined();
  });

  it('идемпотентность: повтор force-отгрузки уже отгруженного заказа отклоняется', async () => {
    H.state.getOrderByIdQueue = [orderDetail({ status: 'shipped' })];
    const res = await changeOrderStatus({
      id: UUID,
      to: 'shipped',
      comment: 'повтор',
      forceStockCommit: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('invalid_transition');
    expect(H.sqlBeginMock).not.toHaveBeenCalled();
  });

  it('force при УСПЕШНОМ списании не оставляет пометку в истории', async () => {
    H.state.getOrderByIdQueue = [orderDetail(), orderDetail({ status: 'shipped' })];
    H.commitReservationMock.mockImplementation(async () => true);

    const res = await changeOrderStatus({
      id: UUID,
      to: 'shipped',
      comment: 'обычная отгрузка',
      forceStockCommit: true,
    });
    expect(res.ok).toBe(true);
    const history = txCall('order_status_history');
    expect(history!.args.some((a) => typeof a === 'string' && a.includes('SKU-1'))).toBe(false);
    const entry = auditEntry();
    expect((entry?.after as Record<string, unknown>)?.forcedStockCommit).toEqual([]);
  });

  it('force не влияет на возврат резерва (отмена) — release не подменяется', async () => {
    // Неоплаченный заказ: отмена ОПЛАЧЕННОГО отдельно гардится денежным путём
    // («бумажный возврат»), а здесь проверяется именно эффект над резервом.
    H.state.getOrderByIdQueue = [
      orderDetail({ paymentStatus: 'pending' }),
      orderDetail({ status: 'cancelled', paymentStatus: 'pending' }),
    ];
    const res = await changeOrderStatus({
      id: UUID,
      to: 'cancelled',
      comment: 'отмена',
      forceStockCommit: true,
    });
    expect(res.ok).toBe(true);
    expect(H.releaseReservationMock).toHaveBeenCalledTimes(1);
    expect(H.commitReservationMock).not.toHaveBeenCalled();
  });
});
