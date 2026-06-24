import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты OrderService (docs/08 §7.1).
 *
 * (а) ЧИСТЫЕ — normalizePhone, buildPayload (ПВЗ/курьер ветки), canCreateShipment,
 *     deliveryModeFor. Без сети/БД, всегда зелёные.
 * (б) createShipment — БД-зависим (repository + orders). Мокаем repository/orders
 *     через vi.mock, чтобы проверить mock-создание (uuid/трек сохранён) и
 *     идемпотентность повторного вызова без живой БД.
 */

// --- Моки БД-слоёв (до импорта тестируемого модуля). ---
const repoState: { shipment: Record<string, unknown> | null } = { shipment: null };
const createShipmentMock = vi.fn(async (input: Record<string, unknown>) => {
  repoState.shipment = { id: 'sh-1', orderId: input.orderId, ...input };
  return repoState.shipment;
});
const updateShipmentMock = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
  repoState.shipment = { ...(repoState.shipment ?? {}), ...patch };
  return repoState.shipment;
});
const getShipmentMock = vi.fn(async () => repoState.shipment);
const bumpRetryMock = vi.fn(async () => repoState.shipment);

// Состояние tx-мока для applyDeliveryStatus (C6-1): SELECT delivery_status FOR UPDATE
// отдаёт deliveryStatus (фактический под локом), guarded UPDATE — updateCount строк.
const txState: { deliveryStatus: string | null; updateCount: number } = {
  deliveryStatus: null,
  updateCount: 1,
};

vi.mock('@/lib/cdek/repository', () => ({
  getShipmentByOrderId: (...a: unknown[]) => getShipmentMock(...(a as [])),
  getShipmentByCdekUuid: vi.fn(async () => null),
  createShipment: (...a: unknown[]) => createShipmentMock(...(a as [Record<string, unknown>])),
  updateShipmentByOrderId: (...a: unknown[]) =>
    updateShipmentMock(...(a as [string, Record<string, unknown>])),
  bumpShipmentRetry: (...a: unknown[]) => bumpRetryMock(...(a as [])),
}));

const getOrderByIdMock = vi.fn();
vi.mock('@/lib/orders/repository', () => ({
  getOrderById: (...a: unknown[]) => getOrderByIdMock(...(a as [])),
  getOrderByNumber: vi.fn(async () => null),
}));

// sql — заглушка (UPDATE orders денормализация + per-order advisory-lock внутри
// sql.begin). vi.mock hoisted → строим внутри. tx распознаёт
// pg_try_advisory_xact_lock и возвращает [{ locked:true }] (лок получен), чтобы
// критическая секция createShipment выполнялась; прочие запросы → [].
vi.mock('@/lib/db/client', () => {
  const tx = vi.fn(async (strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('pg_try_advisory_xact_lock')) return [{ locked: true }];
    // applyDeliveryStatus: SELECT delivery_status FOR UPDATE → фактический статус под локом.
    if (/SELECT\s+delivery_status/i.test(text)) {
      return txState.deliveryStatus === null ? [] : [{ delivery_status: txState.deliveryStatus }];
    }
    // applyDeliveryStatus: guarded UPDATE orders SET delivery_status → .count строк.
    if (/UPDATE\s+orders/i.test(text) && /delivery_status/i.test(text)) {
      const arr: unknown[] = [];
      (arr as unknown as { count: number }).count = txState.updateCount;
      return arr;
    }
    return [];
  });
  const fn = vi.fn(async () => []);
  return {
    sql: Object.assign(fn, { begin: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)) }),
  };
});

import {
  OrderService,
  normalizePhone,
  buildPayload,
  canCreateShipment,
  isOrderPaidForShipment,
  shipmentBlockMessage,
  deliveryModeFor,
  type BuildPayloadOptions,
} from '@/lib/cdek/services/order';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';
import type { Order, OrderItem } from '@/lib/orders/types';

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    number: 'TC-2026-000123',
    status: 'paid',
    itemsTotal: '1000.00',
    discountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '1000.00',
    currency: 'RUB',
    paymentMethod: 'card',
    paymentStatus: 'paid',
    paidAt: new Date(),
    paymentRef: null,
    deliveryType: 'pvz',
    deliveryStatus: 'pending',
    deliveryCity: 'Москва',
    deliveryAddress: null,
    deliveryPvzCode: 'MSK1',
    deliveryCost: '0.00',
    cdekUuid: null,
    cdekTrack: null,
    promoCodeId: null,
    promoCode: null,
    customerId: null,
    customerName: 'Иван Иванов',
    customerEmail: 'ivan@example.com',
    customerPhone: '+7 (912) 345-67-89',
    comment: '',
    idempotencyKey: null,
    source: 'storefront',
    ip: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeItem(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'it-1',
    orderId: 'ord-1',
    productId: 'p-1',
    variantId: 'v-1',
    nameSnapshot: 'Чехол',
    skuSnapshot: 'SKU1',
    attributesSnapshot: {},
    unitPrice: '500.00',
    compareAtSnapshot: null,
    quantity: 2,
    lineTotal: '1000.00',
    isGift: false,
    weightG: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    createdAt: new Date(),
    ...over,
  };
}

const buildOpts: BuildPayloadOptions = {
  defaultDimensions: mockCfg.defaultDimensions,
  fromLocationCode: mockCfg.fromLocationCode,
  shipmentPoint: null,
  defaultTariffCode: mockCfg.defaultTariffCode,
  doorTariffCode: mockCfg.doorTariffCode,
  sender: { name: 'ООО Тест', contactName: 'Менеджер', phone: '+79000000000', email: 's@e.ru', inn: '7700000000' },
};

describe('cdek/order — normalizePhone (чистая)', () => {
  it('10 цифр → +7XXXXXXXXXX', () => {
    expect(normalizePhone('9123456789')).toBe('+79123456789');
  });
  it('11 цифр с 8 → +7…', () => {
    expect(normalizePhone('89123456789')).toBe('+79123456789');
  });
  it('11 цифр с 7 → +7…', () => {
    expect(normalizePhone('79123456789')).toBe('+79123456789');
  });
  it('форматированный (+7 (912) …) → нормализуется', () => {
    expect(normalizePhone('+7 (912) 345-67-89')).toBe('+79123456789');
  });
  it('слишком короткий → ошибка', () => {
    expect(() => normalizePhone('12345')).toThrow();
  });
});

describe('cdek/order — deliveryModeFor / canCreateShipment (чистые)', () => {
  it('courier → door, pvz → pvz', () => {
    expect(deliveryModeFor(makeOrder({ deliveryType: 'courier' }))).toBe('door');
    expect(deliveryModeFor(makeOrder({ deliveryType: 'pvz' }))).toBe('pvz');
  });
  it('pickup → нельзя создавать', () => {
    expect(canCreateShipment(makeOrder({ deliveryType: 'pickup' })).ok).toBe(false);
  });
  it('неоплаченный заказ → нельзя (reason=not_paid)', () => {
    const o = makeOrder({ paymentStatus: 'pending', status: 'awaiting_payment' });
    const res = canCreateShipment(o);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_paid');
  });
  it('оплаченный курьерский → можно', () => {
    expect(canCreateShipment(makeOrder({ deliveryType: 'courier', paymentStatus: 'paid' })).ok).toBe(true);
  });
});

describe('cdek/order — isOrderPaidForShipment (FF.md: накладная только после оплаты)', () => {
  it('payment_status=paid → оплачен (хотя бы статус заказа new)', () => {
    expect(isOrderPaidForShipment({ paymentStatus: 'paid', status: 'new' })).toBe(true);
  });
  it('payment_status=pending + статус awaiting_payment → НЕ оплачен', () => {
    expect(isOrderPaidForShipment({ paymentStatus: 'pending', status: 'awaiting_payment' })).toBe(false);
  });
  it('статус продвинут оператором за оплату (packed) → считаем оплаченным', () => {
    expect(isOrderPaidForShipment({ paymentStatus: 'pending', status: 'packed' })).toBe(true);
  });
  it('новый неоплаченный заказ → НЕ оплачен (накладная недоступна)', () => {
    expect(isOrderPaidForShipment({ paymentStatus: 'pending', status: 'new' })).toBe(false);
  });
  it('сообщение про блокировку not_paid упоминает оплату', () => {
    expect(shipmentBlockMessage('not_paid')).toMatch(/оплат/i);
  });
});

describe('cdek/order — buildPayload (чистая)', () => {
  it('ПВЗ-режим → delivery_point = код ПВЗ', () => {
    const p = buildPayload(makeOrder({ deliveryType: 'pvz', deliveryPvzCode: 'MSK1' }), [makeItem()], buildOpts);
    expect(p.delivery_point).toBe('MSK1');
    expect(p.to_location).toBeUndefined();
    expect(p.type).toBe(1);
    expect(p.number).toBe('TC-2026-000123');
    expect(p.recipient.phones[0].number).toBe('+79123456789');
  });

  it('курьер (door) → to_location, без delivery_point', () => {
    const p = buildPayload(
      makeOrder({ deliveryType: 'courier', deliveryAddress: 'ул. Ленина, 1', deliveryPvzCode: null }),
      [makeItem()],
      buildOpts,
    );
    expect(p.delivery_point).toBeUndefined();
    expect(p.to_location).toBeDefined();
    expect(p.to_location?.address).toBe('ул. Ленина, 1');
  });

  it('M4: ПВЗ-режим → tariff_code = defaultTariffCode (склад-склад 136)', () => {
    const p = buildPayload(makeOrder({ deliveryType: 'pvz', deliveryPvzCode: 'MSK1' }), [makeItem()], buildOpts);
    expect(p.tariff_code).toBe(buildOpts.defaultTariffCode);
    expect(p.tariff_code).toBe(136);
  });

  it('M4: курьер (door) → tariff_code = doorTariffCode (склад-дверь 137), НЕ ПВЗ-тариф', () => {
    const p = buildPayload(
      makeOrder({ deliveryType: 'courier', deliveryAddress: 'ул. Ленина, 1', deliveryPvzCode: null }),
      [makeItem()],
      buildOpts,
    );
    expect(p.tariff_code).toBe(buildOpts.doorTariffCode);
    expect(p.tariff_code).toBe(137);
    expect(p.tariff_code).not.toBe(buildOpts.defaultTariffCode);
  });

  it('from_location из конфига (нет shipment_point)', () => {
    const p = buildPayload(makeOrder(), [makeItem()], buildOpts);
    expect(p.from_location?.code).toBe(buildOpts.fromLocationCode);
    expect(p.shipment_point).toBeUndefined();
  });

  it('shipment_point взаимоисключим с from_location', () => {
    const p = buildPayload(makeOrder(), [makeItem()], { ...buildOpts, shipmentPoint: 'WH-1' });
    expect(p.shipment_point).toBe('WH-1');
    expect(p.from_location).toBeUndefined();
  });

  it('packages агрегирует вес позиций (qty × дефолт), когда снимок пуст', () => {
    const p = buildPayload(makeOrder(), [makeItem({ quantity: 2 })], buildOpts);
    // 2 × дефолтный вес магазина (снимок позиции NULL → дефолт)
    expect(p.packages[0].weight).toBe(buildOpts.defaultDimensions.weightG * 2);
    expect(p.packages[0].items).toHaveLength(1);
    expect(p.packages[0].items[0].ware_key).toBe('v-1');
    // item-уровень тоже на дефолте (вес единицы)
    expect(p.packages[0].items[0].weight).toBe(buildOpts.defaultDimensions.weightG);
  });

  it('packages берёт РЕАЛЬНЫЙ вес/габариты из снимка позиции (а не дефолт)', () => {
    const item = makeItem({ quantity: 2, weightG: 300, lengthCm: 25, widthCm: 12, heightCm: 4 });
    const p = buildPayload(makeOrder(), [item], buildOpts);
    expect(p.packages[0].weight).toBe(300 * 2); // Σ(weightG × qty)
    expect(p.packages[0].length).toBe(25); // max
    expect(p.packages[0].width).toBe(12); // max
    expect(p.packages[0].height).toBe(4 * 2); // Σ(qty × h)
    // item-уровень: вес ЕДИНИЦЫ из снимка
    expect(p.packages[0].items[0].weight).toBe(300);
  });

  it('несколько позиций: вес агрегируется по реальным снимкам', () => {
    const p = buildPayload(
      makeOrder(),
      [
        makeItem({ id: 'a', quantity: 2, weightG: 300, heightCm: 5 }),
        makeItem({ id: 'b', quantity: 1, weightG: 500, heightCm: 8 }),
      ],
      buildOpts,
    );
    expect(p.packages[0].weight).toBe(300 * 2 + 500); // 1100
    expect(p.packages[0].height).toBe(5 * 2 + 8); // 18
  });

  it('ПВЗ-режим без кода ПВЗ → ошибка', () => {
    expect(() =>
      buildPayload(makeOrder({ deliveryType: 'pvz', deliveryPvzCode: null }), [makeItem()], buildOpts),
    ).toThrow();
  });
});

describe('cdek/order — createShipment (mock-создание, repository замокан)', () => {
  beforeEach(() => {
    repoState.shipment = null;
    vi.clearAllMocks();
    getOrderByIdMock.mockResolvedValue({ order: makeOrder(), items: [makeItem()] });
  });

  it('mock: создаёт отправление с фейковым uuid/треком, is_mock=true', async () => {
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    const sh = await svc.createShipment('ord-1');
    expect(createShipmentMock).toHaveBeenCalledTimes(1);
    expect(String((sh as unknown as Record<string, unknown>).cdekUuid)).toMatch(/^mock-/);
    expect(String((sh as unknown as Record<string, unknown>).cdekNumber)).toMatch(/^1\d{9}$/);
    expect((sh as unknown as Record<string, unknown>).isMock).toBe(true);
  });

  it('идемпотентность: повторный createShipment не создаёт второе отправление', async () => {
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    const first = await svc.createShipment('ord-1');
    createShipmentMock.mockClear();
    // повтор — отправление уже с cdek_uuid → возвращается существующее
    const second = await svc.createShipment('ord-1');
    expect(createShipmentMock).not.toHaveBeenCalled();
    expect((second as unknown as Record<string, unknown>).cdekUuid).toBe((first as unknown as Record<string, unknown>).cdekUuid);
  });

  it('pickup → precondition ошибка', async () => {
    getOrderByIdMock.mockResolvedValue({ order: makeOrder({ deliveryType: 'pickup' }), items: [makeItem()] });
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await expect(svc.createShipment('ord-1')).rejects.toThrow();
  });
});

describe('cdek/order — cancelShipment (БАГ #12: нет рассинхрона отправление↔delivery_status)', () => {
  beforeEach(() => {
    repoState.shipment = null;
    txState.deliveryStatus = null;
    txState.updateCount = 1;
    vi.clearAllMocks();
  });

  it('delivery_status=in_transit → precondition CdekError, отправление НЕ помечается CANCELLED, СДЭК не дёргается', async () => {
    repoState.shipment = { id: 'sh-1', orderId: 'ord-1', cdekUuid: 'mock-uuid-1' };
    getShipmentMock.mockResolvedValue(repoState.shipment);
    getOrderByIdMock.mockResolvedValue({
      order: makeOrder({ deliveryStatus: 'in_transit' }),
      items: [makeItem()],
    });
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await expect(svc.cancelShipment('ord-1')).rejects.toThrow();
    // Главное: НЕ перевели отправление в CANCELLED (иначе рассинхрон с in_transit).
    expect(updateShipmentMock).not.toHaveBeenCalled();
  });

  it('delivery_status=delivered → precondition CdekError, отправление НЕ помечается CANCELLED', async () => {
    repoState.shipment = { id: 'sh-1', orderId: 'ord-1', cdekUuid: 'mock-uuid-1' };
    getShipmentMock.mockResolvedValue(repoState.shipment);
    getOrderByIdMock.mockResolvedValue({
      order: makeOrder({ deliveryStatus: 'delivered' }),
      items: [makeItem()],
    });
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await expect(svc.cancelShipment('ord-1')).rejects.toThrow();
    expect(updateShipmentMock).not.toHaveBeenCalled();
  });

  it('delivery_status=pending → отмена проходит, отправление помечается CANCELLED', async () => {
    repoState.shipment = { id: 'sh-1', orderId: 'ord-1', cdekUuid: 'mock-uuid-1' };
    getShipmentMock.mockResolvedValue(repoState.shipment);
    getOrderByIdMock.mockResolvedValue({
      order: makeOrder({ deliveryStatus: 'pending' }),
      items: [makeItem()],
    });
    txState.deliveryStatus = 'pending'; // под локом статус тот же → переход применится
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await expect(svc.cancelShipment('ord-1')).resolves.toBeUndefined();
    expect(updateShipmentMock).toHaveBeenCalledTimes(1);
    const patch = updateShipmentMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.statusCode).toBe('CANCELLED');
  });

  it('delivery_status=registered → отмена проходит (переход registered → cancelled допустим)', async () => {
    repoState.shipment = { id: 'sh-1', orderId: 'ord-1', cdekUuid: 'mock-uuid-1' };
    getShipmentMock.mockResolvedValue(repoState.shipment);
    getOrderByIdMock.mockResolvedValue({
      order: makeOrder({ deliveryStatus: 'registered' }),
      items: [makeItem()],
    });
    txState.deliveryStatus = 'registered';
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await expect(svc.cancelShipment('ord-1')).resolves.toBeUndefined();
    expect(updateShipmentMock).toHaveBeenCalledTimes(1);
  });

  it('C6-1: гонка — precondition прошла (registered), но под FOR UPDATE статус уже in_transit → CdekError, отправление НЕ помечается CANCELLED', async () => {
    // Параллельный webhook продвинул статус между ранней precondition и переходом.
    repoState.shipment = { id: 'sh-1', orderId: 'ord-1', cdekUuid: 'mock-uuid-1' };
    getShipmentMock.mockResolvedValue(repoState.shipment);
    getOrderByIdMock.mockResolvedValue({
      order: makeOrder({ deliveryStatus: 'registered' }), // ранняя precondition: отмена допустима
      items: [makeItem()],
    });
    txState.deliveryStatus = 'in_transit'; // но под локом уже in_transit → переход не применится
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await expect(svc.cancelShipment('ord-1')).rejects.toThrow();
    // Ключевое (анти-рассинхрон C6-1): отправление НЕ помечено CANCELLED.
    expect(updateShipmentMock).not.toHaveBeenCalled();
  });

  it('нет отправления (cdek_uuid пуст) → CdekError, отправление не трогаем', async () => {
    repoState.shipment = null;
    getShipmentMock.mockResolvedValue(null);
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await expect(svc.cancelShipment('ord-1')).rejects.toThrow();
    expect(updateShipmentMock).not.toHaveBeenCalled();
  });
});

describe('cdek/order — createShipment (real, замоканный client)', () => {
  beforeEach(() => {
    repoState.shipment = null;
    vi.clearAllMocks();
    getOrderByIdMock.mockResolvedValue({ order: makeOrder(), items: [makeItem()] });
  });

  it('real: POST /v2/orders, uuid из entity сохраняется', async () => {
    const realCfg = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_ACCOUNT: 'acc',
      CDEK_SECRET: 'sec',
      CDEK_BASE_URL: 'https://api.edu.cdek.ru',
    });
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/v2/orders');
      return new Response(JSON.stringify({ entity: { uuid: 'real-uuid-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };
    const svc = new OrderService(new CdekManager({ config: realCfg, fetchImpl, tokenCache }));
    const sh = await svc.createShipment('ord-1');
    expect((sh as unknown as Record<string, unknown>).cdekUuid).toBe('real-uuid-1');
    expect((sh as unknown as Record<string, unknown>).isMock).toBe(false);
  });
});
