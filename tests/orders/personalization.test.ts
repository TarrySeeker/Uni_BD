import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Персонализация позиции в заказе (миграция 0034) — интеграционный слой.
 *
 * Проверяется сквозной путь, а не только схема: описание полей лежит в карточке
 * товара, значения приходят «с витрины», сервер валидирует их ПО ОПИСАНИЮ ИЗ БД
 * и кладёт снимок в `order_items.personalization`. Ровно этим снимком цех узнаёт,
 * что наносить, поэтому проверяем и его сохранность, а не только код ответа.
 *
 * Нужна живая БД с миграциями (как и tests/orders/repository.test.ts): без
 * DATABASE_URL блок пропускается.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** Описание намеренно из другой ниши, чем гравировка, — механизм не про флешки. */
const SPEC = {
  fields: [
    {
      key: 'engraving',
      type: 'text_lines',
      label: 'Надпись',
      lines: 3,
      maxLength: 20,
      required: true,
    },
    {
      key: 'sign',
      type: 'select',
      label: 'Знак',
      options: [
        { value: 'hoop', label: 'Обруч' },
        { value: 'ball', label: 'Мяч' },
      ],
      allowEmpty: true,
      emptyLabel: 'Без знака',
    },
  ],
};

describe.skipIf(!INTEGRATION_DB_URL)('orders — персонализация позиции (нужна БД)', () => {
  let repo: typeof import('@/lib/orders/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const created = { productIds: [] as string[], orderIds: [] as string[] };

  async function makeProduct(personalization: unknown): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price, personalization)
      VALUES (
        ${'PZ-' + suffix}, ${'pz-' + suffix}, ${'PersTest ' + suffix}, 'active', '1000.00',
        ${personalization === null ? null : sql.json(personalization as never)}
      )
      RETURNING id
    `;
    created.productIds.push(p!.id);
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${p!.id}, NULL, 'main', 50, 0)
    `;
    return p!.id;
  }

  function order(productId: string, personalization?: unknown) {
    return {
      items: [{ productId, qty: 1, ...(personalization === undefined ? {} : { personalization }) }],
      customer: { name: 'Покупатель', email: 'pers@example.com', phone: '+70000000000' },
      delivery: { type: 'pvz' as const, city: 'Ростов-на-Дону', pvzCode: 'ROV1' },
      paymentMethod: 'cod' as const,
    };
  }

  beforeAll(async () => {
    repo = await import('@/lib/orders/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    await sql`DELETE FROM orders WHERE customer_email = 'pers@example.com'`;
    for (const id of created.productIds) {
      await sql`DELETE FROM inventory WHERE product_id = ${id}`;
      await sql`DELETE FROM products WHERE id = ${id}`;
    }
    if (closeSql) await closeSql();
  });

  it('снимок персонализации доезжает до строки заказа целиком', async () => {
    const productId = await makeProduct(SPEC);
    const res = await repo.createOrder(
      order(productId, { engraving: ['Иванова', 'Амелия', '2017'], sign: 'hoop' }) as never,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    created.orderIds.push(res.order.id);

    const [row] = await sql<{ personalization: Record<string, never> }[]>`
      SELECT personalization FROM order_items WHERE order_id = ${res.order.id}
    `;
    const snap = row!.personalization as unknown as {
      spec: { fields: { key: string; label: string }[] };
      values: Record<string, unknown>;
    };
    expect(snap.values).toEqual({ engraving: ['Иванова', 'Амелия', '2017'], sign: 'hoop' });
    // Вместе со значениями снят и словарь подписей: карточка заказа читается
    // без обращения к каталогу, даже если товар потом удалят.
    expect(snap.spec.fields.map((f) => f.label)).toEqual(['Надпись', 'Знак']);
  });

  it('снимок описания переживает правку карточки товара', async () => {
    // ADR-010: история заказа не меняется от правок каталога. Подписи и словарь
    // вариантов — часть того, что читает цех, поэтому они тоже в снимке.
    const productId = await makeProduct(SPEC);
    const res = await repo.createOrder(
      order(productId, { engraving: ['Иванова'], sign: 'hoop' }) as never,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    created.orderIds.push(res.order.id);

    await sql`UPDATE products SET personalization = NULL WHERE id = ${productId}`;

    const [row] = await sql<{ personalization: unknown }[]>`
      SELECT personalization FROM order_items WHERE order_id = ${res.order.id}
    `;
    const { describeSnapshot } = await import('@/lib/personalization/schemas');
    expect(describeSnapshot(row!.personalization)).toEqual([
      { label: 'Надпись', value: 'Иванова' },
      { label: 'Знак', value: 'Обруч' },
    ]);
  });

  it('пустая строка внутри надписи сохраняет своё место', async () => {
    const productId = await makeProduct(SPEC);
    const res = await repo.createOrder(
      order(productId, { engraving: ['Иванова', '', '2017'] }) as never,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    created.orderIds.push(res.order.id);

    const [row] = await sql<{ personalization: { values: { engraving: string[] } } }[]>`
      SELECT personalization FROM order_items WHERE order_id = ${res.order.id}
    `;
    expect(row!.personalization.values.engraving).toEqual(['Иванова', '', '2017']);
  });

  it('обязательное поле нельзя пропустить — заказ не создаётся', async () => {
    const productId = await makeProduct(SPEC);
    const res = await repo.createOrder(order(productId, { sign: 'hoop' }) as never);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/Надпись/);
  });

  it('вариант вне списка отклоняется сервером, даже если витрина его прислала', async () => {
    // Anti-tamper: описание берётся из БД, а не из запроса (ADR-010).
    const productId = await makeProduct(SPEC);
    const res = await repo.createOrder(
      order(productId, { engraving: ['Тест'], sign: 'ribbon' }) as never,
    );
    expect(res.ok).toBe(false);
  });

  it('слишком длинная строка отклоняется, а не обрезается молча', async () => {
    const productId = await makeProduct(SPEC);
    const res = await repo.createOrder(
      order(productId, { engraving: ['ЭтоОченьДлиннаяНадписьКотораяНеВлезает'] }) as never,
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/20/);
  });

  it('товар без персонализации не принимает её', async () => {
    const productId = await makeProduct(null);
    const res = await repo.createOrder(order(productId, { engraving: ['Иванова'] }) as never);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/не персонализируется/i);
  });

  it('товар без персонализации заказывается как раньше — снимок пустой', async () => {
    const productId = await makeProduct(null);
    const res = await repo.createOrder(order(productId) as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    created.orderIds.push(res.order.id);

    const [row] = await sql<{ personalization: unknown }[]>`
      SELECT personalization FROM order_items WHERE order_id = ${res.order.id}
    `;
    expect(row!.personalization).toEqual({});
  });

  it('персонализированный товар без присланных значений отклоняется (поле обязательно)', async () => {
    const productId = await makeProduct(SPEC);
    const res = await repo.createOrder(order(productId) as never);
    expect(res.ok).toBe(false);
  });
});
