import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mapOrder } from '@/lib/orders/repository';
import { deliverySelectionSchema } from '@/lib/orders/schemas';
import { toOrderPublicDto } from '@/lib/storefront/order-dto';

/**
 * §9: постамат (orders.is_postamat) — подвид ПВЗ через флаг, БЕЗ изменения
 * CHECK delivery_type. Аддитивно/обратно совместимо.
 *
 * (а) ЮНИТ — mapOrder (row→domain, NULL/отсутствие → false), схема доставки
 *     (isPostamat опц.), OrderPublicDto пробрасывает флаг наружу.
 * (б) ИНТЕГРАЦИЯ (skipIf без БД) — round-trip колонки на :5434 + DEFAULT false.
 */

const D = new Date('2026-01-01T00:00:00Z');

/** Минимальная orders-строка (SELECT *): всё, что читает mapOrder. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'o1', number: 'GA-2026-000001', status: 'new',
    items_total: '100.00', discount_total: '0.00', delivery_total: '0.00',
    grand_total: '100.00', currency: 'RUB', payment_method: 'card',
    payment_status: 'pending', paid_at: null, payment_ref: null, payment_provider: null,
    delivery_type: 'pvz', delivery_status: 'pending',
    delivery_city: 'Москва', delivery_address: null, delivery_pvz_code: 'MSK1',
    delivery_cost: null, cdek_uuid: null, cdek_track: null,
    promo_code_id: null, promo_code: null, gift_certificate_id: null,
    gift_discount_total: '0.00', customer_id: null, customer_name: 'A',
    customer_email: 'a@b.c', customer_phone: '+70000000000', comment: '',
    idempotency_key: null, source: 'storefront', ip: null,
    created_at: D, updated_at: D, ...over,
  };
}

// =============================================================================
// (а) ЮНИТ.
// =============================================================================
describe('§9 postamat — mapOrder/схема/DTO (юнит)', () => {
  it('mapOrder: is_postamat=true → isPostamat true', () => {
    expect(mapOrder(row({ is_postamat: true })).isPostamat).toBe(true);
  });

  it('mapOrder: обратная совместимость — is_postamat отсутствует/NULL → false', () => {
    expect(mapOrder(row()).isPostamat).toBe(false);
    expect(mapOrder(row({ is_postamat: null })).isPostamat).toBe(false);
    expect(mapOrder(row({ is_postamat: false })).isPostamat).toBe(false);
  });

  it('deliverySelectionSchema: isPostamat опционален (поверх type=pvz)', () => {
    expect(deliverySelectionSchema.safeParse({ type: 'pvz', pvzCode: 'MSK1', isPostamat: true }).success).toBe(true);
    // Без флага — валидно (старая витрина).
    expect(deliverySelectionSchema.safeParse({ type: 'pvz', pvzCode: 'MSK1' }).success).toBe(true);
    // Курьер без постамата — валидно.
    expect(deliverySelectionSchema.safeParse({ type: 'courier', address: 'ул. 1' }).success).toBe(true);
  });

  it('toOrderPublicDto: delivery.isPostamat пробрасывается наружу', () => {
    const on = toOrderPublicDto(mapOrder(row({ is_postamat: true })), []);
    expect(on.delivery.isPostamat).toBe(true);
    const off = toOrderPublicDto(mapOrder(row()), []);
    expect(off.delivery.isPostamat).toBe(false);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('§9 postamat (интеграция, нужна БД)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  const ids: string[] = [];
  const tag = 'PM-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  beforeAll(async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    for (const id of ids) await sql`DELETE FROM orders WHERE id = ${id}`;
    if (closeSql) await closeSql();
  });

  async function insert(over: { isPostamat?: boolean } = {}): Promise<string> {
    const num = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
    // orders требует NOT NULL customer_* — заполняем минимально валидно.
    const rows =
      over.isPostamat === undefined
        ? await sql<{ id: string }[]>`
            INSERT INTO orders
              (number, status, items_total, grand_total, delivery_type,
               customer_name, customer_email, customer_phone)
            VALUES (${num}, 'new', '100.00', '100.00', 'pvz',
               'Тест', 't@x.y', '+70000000000')
            RETURNING id`
        : await sql<{ id: string }[]>`
            INSERT INTO orders
              (number, status, items_total, grand_total, delivery_type, is_postamat,
               customer_name, customer_email, customer_phone)
            VALUES (${num}, 'new', '100.00', '100.00', 'pvz', ${over.isPostamat},
               'Тест', 't@x.y', '+70000000000')
            RETURNING id`;
    ids.push(rows[0]!.id);
    return rows[0]!.id;
  }

  it('is_postamat round-trip: true пишется/читается через mapOrder', async () => {
    const id = await insert({ isPostamat: true });
    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM orders WHERE id = ${id}`;
    expect(mapOrder(rows[0]!).isPostamat).toBe(true);
  });

  it('DEFAULT false: вставка без is_postamat → false (обратная совместимость)', async () => {
    const id = await insert();
    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM orders WHERE id = ${id}`;
    expect(mapOrder(rows[0]!).isPostamat).toBe(false);
  });
});
