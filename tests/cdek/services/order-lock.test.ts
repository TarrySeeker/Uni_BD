import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты ПЕР-ЗАКАЗ advisory-lock в OrderService.createShipment
 * (анти-гонка, data-integrity).
 *
 * БАГ (major): createShipment был неатомарным read-then-act:
 *   getShipmentByOrderId (read, existing=null) → POST /v2/orders в СДЭК
 *   (удалённый side-effect) → ТОЛЬКО ПОТОМ INSERT cdek_shipments.
 * UNIQUE uq_cdek_shipments_order защищал лишь локальный INSERT. При гонке
 * (двойной тик cron / ручное создание из админки) оба вызова видели
 * existing=null, оба POST-или в СДЭК → ДВЕ реальные накладные; второй INSERT
 * падал на unique (failed), оставляя осиротевшую дублирующую накладную в СДЭК.
 *
 * Фикс: createShipment берёт pg_try_advisory_xact_lock по order id внутри
 * sql.begin и ПЕРЕпроверяет getShipmentByOrderId ПОД ЛОКОМ до удалённого
 * create. Удалённый POST для одного заказа делает только один воркер.
 *
 * Живой advisory-lock без БД невозможен → проверяем на моке sql.begin:
 * фиксируем, что pg_try_advisory_xact_lock вызван и что повторная проверка
 * существования происходит внутри транзакции до манагерского create.
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

// --- Мок sql/sql.begin, отслеживающий advisory-lock запрос. ---
// Поведение лока настраивается через lockState.locked. tx(...) распознаёт
// pg_try_advisory_xact_lock по тексту запроса (первый фрагмент tagged-template)
// и возвращает [{ locked }]; прочие запросы → [].
const lockState = { locked: true, lockCalls: 0 };

const tx = vi.fn(async (strings: TemplateStringsArray, ..._v: unknown[]) => {
  const text = Array.isArray(strings) ? strings.join('') : String(strings);
  if (text.includes('pg_try_advisory_xact_lock')) {
    lockState.lockCalls += 1;
    return [{ locked: lockState.locked }];
  }
  return [];
});

vi.mock('@/lib/db/client', () => {
  const fn = vi.fn(async () => []);
  return {
    sql: Object.assign(fn, {
      begin: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    }),
  };
});

import { OrderService } from '@/lib/cdek/services/order';
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
    paymentProvider: null,
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

describe('OrderService.createShipment — per-order advisory-lock (анти-гонка)', () => {
  beforeEach(() => {
    repoState.shipment = null;
    lockState.locked = true;
    lockState.lockCalls = 0;
    vi.clearAllMocks();
    getOrderByIdMock.mockResolvedValue({ order: makeOrder(), items: [makeItem()] });
  });

  it('берёт pg_try_advisory_xact_lock по заказу перед удалённым create', async () => {
    const svc = new OrderService(new CdekManager({ config: mockCfg }));
    await svc.createShipment('ord-1');
    expect(lockState.lockCalls).toBeGreaterThanOrEqual(1);
    expect(createShipmentMock).toHaveBeenCalledTimes(1);
  });

  it('повторная проверка под локом: отправление появилось во время гонки → не создаём второе (real-режим, удалённый POST не вызывается)', async () => {
    // real-менеджер с замоканным fetch: если код дойдёт до удалённого create —
    // fetch будет вызван. Под локом перепроверка должна это предотвратить.
    const realCfg = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_ACCOUNT: 'acc',
      CDEK_SECRET: 'sec',
      CDEK_BASE_URL: 'https://api.edu.cdek.ru',
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ entity: { uuid: 'should-not-happen' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };

    // Первая проверка (вне лока) — пусто; повторная проверка ПОД ЛОКОМ — уже создано
    // конкурентом (с cdek_uuid). Второй вызов getShipmentByOrderId возвращает
    // существующее отправление.
    getShipmentMock
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce({ id: 'sh-1', orderId: 'ord-1', cdekUuid: 'concurrent-uuid' }); // под локом

    const svc = new OrderService(
      new CdekManager({ config: realCfg, fetchImpl, tokenCache }),
    );
    const sh = await svc.createShipment('ord-1');

    // Удалённый POST в СДЭК НЕ должен произойти — перепроверка под локом отсекла гонку.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((sh as unknown as Record<string, unknown>).cdekUuid).toBe('concurrent-uuid');
  });

  it('лок НЕ получен (другой воркер держит лок по заказу) → не делаем удалённый create', async () => {
    lockState.locked = false;
    const realCfg = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_ACCOUNT: 'acc',
      CDEK_SECRET: 'sec',
      CDEK_BASE_URL: 'https://api.edu.cdek.ru',
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ entity: { uuid: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };

    const svc = new OrderService(
      new CdekManager({ config: realCfg, fetchImpl, tokenCache }),
    );
    await expect(svc.createShipment('ord-1')).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createShipmentMock).not.toHaveBeenCalled();
  });
});
