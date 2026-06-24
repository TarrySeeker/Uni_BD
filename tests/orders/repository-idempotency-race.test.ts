import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ЮНИТ-тест гонки идемпотентного создания заказа (BUG #2, reliability) — БЕЗ БД.
 *
 * Сценарий: два параллельных POST /orders с ОДНИМ Idempotency-Key. Первый
 * вставляет строку, второй проходит предтранзакционную проверку (ещё не видит
 * чужую вставку), доходит до INSERT внутри транзакции и ловит нарушение
 * UNIQUE-индекса orders_idempotency_uniq (PostgreSQL 23505). ДО фикса это
 * исключение не обрабатывалось → клиент получал 500 вместо уже созданного
 * заказа. ОЖИДАНИЕ: при конфликте idempotency_key вернуть СУЩЕСТВУЮЩИЙ заказ
 * (как успешный идемпотентный повтор, reused=true), а не падать.
 *
 * Слой данных createOrder тянет sql/catalog/settings/delivery напрямую —
 * изолируем их vi.mock-ами, реальной БД/сети нет.
 */

// --- управляемое состояние моков ---------------------------------------------

const H = vi.hoisted(() => {
  const state = {
    /** Очередь результатов для верхнеуровневых sql`...` (вне транзакции). */
    sqlResultQueue: [] as unknown[][],
    /**
     * Что бросит sql.begin при вызове. Когда задано — транзакция «падает» с этой
     * ошибкой (модель гонки: INSERT нарвался на UNIQUE).
     */
    beginThrows: null as unknown,
  };

  // Верхнеуровневый sql`...`: снимает результат из очереди (по умолчанию []).
  const sqlTagged = vi.fn((..._args: unknown[]) => {
    const next = state.sqlResultQueue.length > 0 ? state.sqlResultQueue.shift()! : [];
    return Promise.resolve(next);
  });
  const sqlBeginMock = vi.fn(async (_cb: (tx: unknown) => Promise<unknown>) => {
    if (state.beginThrows !== null) {
      throw state.beginThrows;
    }
    // Без заданной ошибки — не должен вызываться в этом тесте.
    throw new Error('sql.begin: unexpected call without beginThrows set');
  });

  return { state, sqlTagged, sqlBeginMock };
});

// --- vi.mock (hoisted) -------------------------------------------------------

vi.mock('@/lib/db/client', () => {
  const sqlFn = (...args: unknown[]) => H.sqlTagged(...args);
  (sqlFn as unknown as { begin: unknown }).begin = H.sqlBeginMock;
  (sqlFn as unknown as { json: unknown }).json = (v: unknown) => v;
  return { sql: sqlFn };
});

vi.mock('@/lib/config/env', () => ({
  getEnv: () => ({ SHOP_CURRENCY: 'RUB', SHOP_ORDER_PREFIX: '' }),
}));

vi.mock('@/lib/config/settings', () => ({
  getEffectiveSettings: async () => ({
    delivery: { freeDeliveryThreshold: 0 },
  }),
}));

// Назначение СДЭК не нужно для этого теста: доставка курьером, расчёт 0/любой —
// итог тут не проверяем, важно лишь поведение catch на 23505.
vi.mock('@/lib/orders/delivery-cost', () => ({
  computeDeliveryCost: async () => ({
    cost: '0.00',
    etaDays: null,
    periodMin: null,
    periodMax: null,
    tariffCode: null,
    source: 'stub' as const,
    provider: 'stub',
  }),
}));

// resolveCartLine резолвит позицию из «каталога» (anti-tamper) — подменяем, чтобы
// не дёргать catalog/sql. Возвращаем готовую ценовую строку.
vi.mock('@/lib/catalog/repository', () => ({
  getProductById: async () => ({
    id: 'p-1',
    name: 'Товар',
    sku: 'SKU-1',
    status: 'active',
    basePrice: '100.00',
    compareAtPrice: null,
    brandId: null,
    categories: [],
    variants: [],
    inventory: [{ warehouseCode: 'main', variantId: null, quantity: 10, reserved: 0 }],
    attributesCache: {},
    weightG: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
  }),
}));

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY_KEY = 'idem-race-key-001';

// Существующий заказ, который ДОЛЖЕН быть возвращён при конфликте (вставил «первый»).
const EXISTING_ORDER_ROW: Record<string, unknown> = {
  id: '22222222-2222-4222-8222-222222222222',
  number: 'GA-2026-000001',
  status: 'new',
  items_total: '100.00',
  discount_total: '0.00',
  delivery_total: '0.00',
  grand_total: '100.00',
  currency: 'RUB',
  payment_method: 'cod',
  payment_status: 'pending',
  delivery_type: 'courier',
  delivery_status: 'pending',
  customer_name: 'Покупатель',
  customer_email: 'buyer@example.com',
  customer_phone: '+70000000000',
  comment: '',
  idempotency_key: IDEMPOTENCY_KEY,
  source: 'storefront',
  created_at: new Date('2026-06-17T00:00:00Z'),
  updated_at: new Date('2026-06-17T00:00:00Z'),
};

/** Имитация ошибки postgres.js: нарушение UNIQUE-индекса (код 23505). */
function uniqueViolation(): Error {
  const err = new Error(
    'duplicate key value violates unique constraint "orders_idempotency_uniq"',
  ) as Error & { code: string; constraint_name: string };
  err.code = '23505';
  err.constraint_name = 'orders_idempotency_uniq';
  return err;
}

const ARGS = {
  items: [{ productId: PRODUCT_ID, qty: 1 }],
  customer: { name: 'Покупатель', email: 'buyer@example.com', phone: '+70000000000' },
  delivery: { type: 'courier' as const },
  paymentMethod: 'cod' as const,
  idempotencyKey: IDEMPOTENCY_KEY,
};

describe('orders/repository createOrder — гонка идемпотентности (BUG #2)', () => {
  let createOrder: typeof import('@/lib/orders/repository').createOrder;

  beforeEach(async () => {
    H.state.sqlResultQueue = [];
    H.state.beginThrows = null;
    H.sqlTagged.mockClear();
    H.sqlBeginMock.mockClear();
    ({ createOrder } = await import('@/lib/orders/repository'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('конфликт UNIQUE idempotency_key (23505) → возвращает существующий заказ, не throw', async () => {
    // 1) Предтранзакционная проверка идемпотентности: ключа ещё нет → [].
    // 2) Транзакция падает с 23505 (конкурент уже вставил строку).
    // 3) Catch повторяет SELECT по ключу и находит чужую вставку → возвращает её.
    H.state.sqlResultQueue = [
      [], // SELECT ... WHERE idempotency_key (предтранзакционно) — пусто
      [EXISTING_ORDER_ROW], // SELECT ... WHERE idempotency_key (в catch после 23505)
    ];
    H.state.beginThrows = uniqueViolation();

    const res = await createOrder(ARGS);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reused).toBe(true);
    expect(res.order.id).toBe(EXISTING_ORDER_ROW.id);
    expect(res.order.number).toBe('GA-2026-000001');
    // Транзакция действительно была инициирована (и упала на 23505).
    expect(H.sqlBeginMock).toHaveBeenCalledTimes(1);
  });

  it('23505 без idempotencyKey → пробрасывает ошибку (не маскируем чужие конфликты)', async () => {
    // Без ключа конфликт по другому индексу маскировать нельзя — пробрасываем.
    const argsNoKey = { ...ARGS, idempotencyKey: undefined };
    H.state.beginThrows = uniqueViolation();

    await expect(createOrder(argsNoKey)).rejects.toThrow();
  });

  it('конфликт 23505, но заказ по ключу не найден в catch → пробрасывает ошибку', async () => {
    // Защитный край: 23505 пришёл, но повторный SELECT пуст (теоретически — иной
    // конфликт/гонка отката). Не выдумываем успех — пробрасываем исходную ошибку.
    H.state.sqlResultQueue = [
      [], // предтранзакционный SELECT — пусто
      [], // SELECT в catch — тоже пусто
    ];
    H.state.beginThrows = uniqueViolation();

    await expect(createOrder(ARGS)).rejects.toThrow();
  });
});
