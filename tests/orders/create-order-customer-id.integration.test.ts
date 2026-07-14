import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — createOrder пишет orders.customer_id
 * из СЕРВЕРНОГО контекста (docs/24 §6, шаг 7b). SECURITY-CRITICAL order-path.
 * Реальная БД :5434, миграции 0013 (orders.customer_id + FK) и 0044.
 *
 * Проверяет:
 *  - авторизованный чекаут (ctx.customerId из валидной сессии) → orders.customer_id
 *    = именно этот id;
 *  - гость (ctx без customerId) → orders.customer_id = NULL (регресс гостевого потока);
 *  - customer_id, подсунутый в ТЕЛЕ запроса, ИГНОРИРУЕТСЯ (createOrder читает только
 *    ctx.customerId; CreateOrderSchema поля customer_id не содержит);
 *  - несуществующий customer_id в ctx → FK (0013) роняет вставку (заказ не создаётся).
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('createOrder — orders.customer_id из сессии (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/orders/repository');
  let custRepo: typeof import('@/lib/customer-auth/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const created = {
    productIds: [] as string[],
    orderEmails: new Set<string>(),
    customerEmails: [] as string[],
  };

  async function makeProduct(basePrice = '300.00', quantity = 100): Promise<string> {
    const s = Math.random().toString(36).slice(2, 10);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${'CID-' + s}, ${'cid-' + s}, ${'CidTest ' + s}, 'active', ${basePrice})
      RETURNING id
    `;
    created.productIds.push(p!.id);
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${p!.id}, NULL, 'main', ${quantity}, 0)
    `;
    return p!.id;
  }

  async function makeAccount(): Promise<{ id: string; email: string }> {
    const email = `cid-acct-${Math.random().toString(36).slice(2, 8)}@example.io`;
    created.customerEmails.push(email);
    const c = await custRepo.insertOrUpgradeAccount({ email, passwordHash: '$argon2id$fake' });
    return { id: c!.id, email };
  }

  function customer(email: string) {
    created.orderEmails.add(email);
    return { name: 'Покупатель', email, phone: '+70000000000' };
  }

  beforeAll(async () => {
    repo = await import('@/lib/orders/repository');
    custRepo = await import('@/lib/customer-auth/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    for (const email of created.orderEmails) {
      await sql`DELETE FROM orders WHERE customer_email = ${email}`;
    }
    for (const id of created.productIds) {
      await sql`DELETE FROM inventory WHERE product_id = ${id}`;
      await sql`DELETE FROM products WHERE id = ${id}`;
    }
    for (const email of created.customerEmails) {
      await sql`DELETE FROM customers WHERE email = ${email}`;
    }
    if (closeSql) await closeSql();
  });

  it('авторизованный чекаут: ctx.customerId → orders.customer_id = этот id', async () => {
    const productId = await makeProduct();
    const acct = await makeAccount();
    const r = await repo.createOrder(
      {
        items: [{ productId, qty: 1 }],
        customer: customer('cid-auth@example.com'),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
      },
      { source: 'storefront', customerId: acct.id },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.customerId).toBe(acct.id);
    // Round-trip из БД подтверждает запись колонки.
    const [row] = await sql<{ customer_id: string }[]>`
      SELECT customer_id FROM orders WHERE id = ${r.order.id}
    `;
    expect(row!.customer_id).toBe(acct.id);
  });

  it('гость: ctx без customerId → orders.customer_id = NULL (регресс)', async () => {
    const productId = await makeProduct();
    const r = await repo.createOrder(
      {
        items: [{ productId, qty: 1 }],
        customer: customer('cid-guest@example.com'),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
      },
      { source: 'storefront' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.customerId).toBeNull();
    const [row] = await sql<{ customer_id: string | null }[]>`
      SELECT customer_id FROM orders WHERE id = ${r.order.id}
    `;
    expect(row!.customer_id).toBeNull();
  });

  it('SECURITY: customer_id в ТЕЛЕ запроса игнорируется (читается только ctx)', async () => {
    const productId = await makeProduct();
    const victim = await makeAccount();
    // Тело содержит подставной customerId чужого аккаунта — createOrder его НЕ читает.
    const rogueInput = {
      items: [{ productId, qty: 1 }],
      customer: customer('cid-rogue@example.com'),
      delivery: { type: 'pickup' as const },
      paymentMethod: 'cod' as const,
      customerId: victim.id, // rogue поле тела
      customer_id: victim.id, // и snake-вариант
    };
    // ctx НЕ передаёт customerId (гость) → должно быть NULL, а не victim.id.
    const r = await repo.createOrder(rogueInput as never, { source: 'storefront' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.customerId).toBeNull();
    expect(r.order.customerId).not.toBe(victim.id);
  });

  it('несуществующий customer_id в ctx → FK (0013) роняет вставку (заказ не создан)', async () => {
    const productId = await makeProduct();
    const fakeId = '00000000-0000-0000-0000-0000000000ff';
    await expect(
      repo.createOrder(
        {
          items: [{ productId, qty: 1 }],
          customer: customer('cid-fk@example.com'),
          delivery: { type: 'pickup' },
          paymentMethod: 'cod',
        },
        { source: 'storefront', customerId: fakeId },
      ),
    ).rejects.toThrow();
    // Заказ не создан (ROLLBACK).
    const rows = await sql`SELECT id FROM orders WHERE customer_email = ${'cid-fk@example.com'}`;
    expect(rows.length).toBe(0);
  });
});
