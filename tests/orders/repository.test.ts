import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Интеграционные тесты слоя данных orders (docs/07 §3.4, §4.2, §6, ADR-010):
 * quoteCart, createOrder (резерв/номер/идемпотентность), гонка резерва.
 *
 * Нужна живая БД с применёнными миграциями 0001..0016 + каталог. В этой среде
 * PostgreSQL нет → describe пропускается (skipIf без DATABASE_URL). Тесты сами
 * создают товар/вариант/остаток и убирают за собой.
 */

const INTEGRATION_DB_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('orders/repository (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/orders/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  // Идентификаторы созданных фикстур (для cleanup).
  const created = {
    productIds: [] as string[],
    promoIds: [] as string[],
    orderIds: [] as string[],
    categoryIds: [] as string[],
  };

  /** Создаёт активный товар с inventory(main) и возвращает productId. */
  async function makeProduct(opts: {
    basePrice: string;
    quantity: number;
    reserved?: number;
    /** Реальный вес единицы (граммы) — для проверки BUG A (anti-undercharge). */
    weightG?: number;
  }): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price, weight_g)
      VALUES (${'OT-' + suffix}, ${'ot-' + suffix}, ${'OrderTest ' + suffix}, 'active', ${opts.basePrice}, ${opts.weightG ?? null})
      RETURNING id
    `;
    const productId = p!.id;
    created.productIds.push(productId);
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${productId}, NULL, 'main', ${opts.quantity}, ${opts.reserved ?? 0})
    `;
    return productId;
  }

  async function makePromo(over: {
    code: string;
    kind: string;
    value?: string;
    minOrderTotal?: string;
    usageLimit?: number | null;
    perCustomerLimit?: number | null;
    bogoBuyQty?: number | null;
    bogoPayQty?: number | null;
    applyScope?: 'cart' | 'category' | 'brand' | 'set';
    minQty?: number | null;
    giftProductId?: string | null;
    giftVariantId?: string | null;
    giftQty?: number | null;
  }): Promise<string> {
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO promo_codes (
        code, kind, value, min_order_total, usage_limit, per_customer_limit,
        bogo_buy_qty, bogo_pay_qty, apply_scope, min_qty,
        gift_product_id, gift_variant_id, gift_qty, is_active
      )
      VALUES (
        ${over.code}, ${over.kind}, ${over.value ?? '0'}, ${over.minOrderTotal ?? '0'},
        ${over.usageLimit ?? null}, ${over.perCustomerLimit ?? null},
        ${over.bogoBuyQty ?? null}, ${over.bogoPayQty ?? null},
        ${over.applyScope ?? 'cart'}, ${over.minQty ?? null},
        ${over.giftProductId ?? null}, ${over.giftVariantId ?? null}, ${over.giftQty ?? null}, true
      )
      RETURNING id
    `;
    created.promoIds.push(r!.id);
    return r!.id;
  }

  /** Привязывает товар к категории (для scope='category' таргетинга). */
  async function linkProductCategory(productId: string, categoryId: string): Promise<void> {
    await sql`
      INSERT INTO product_categories (product_id, category_id, is_primary)
      VALUES (${productId}, ${categoryId}, true)
      ON CONFLICT DO NOTHING
    `;
  }

  /** Создаёт категорию и возвращает её id. */
  async function makeCategory(): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name)
      VALUES (${'cat-' + suffix}, ${'Cat ' + suffix})
      RETURNING id
    `;
    created.categoryIds.push(c!.id);
    return c!.id;
  }

  /** Добавляет таргет акции (category). */
  async function addCategoryTarget(promoId: string, categoryId: string): Promise<void> {
    await sql`
      INSERT INTO promo_targets (promo_code_id, target_type, category_id)
      VALUES (${promoId}, 'category', ${categoryId})
      ON CONFLICT DO NOTHING
    `;
  }

  function customer(email = 'buyer@example.com') {
    return { name: 'Покупатель', email, phone: '+70000000000' };
  }

  beforeAll(async () => {
    repo = await import('@/lib/orders/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    // Cleanup в обратном порядке зависимостей.
    for (const id of created.orderIds) {
      await sql`DELETE FROM orders WHERE id = ${id}`;
    }
    await sql`DELETE FROM orders WHERE customer_email IN ('buyer@example.com','race@example.com','limit@example.com','percust@example.com','percustrace@example.com','gift@example.com','giftnostock@example.com','scopemin@example.com')`;
    for (const id of created.promoIds) {
      await sql`DELETE FROM promo_codes WHERE id = ${id}`;
    }
    for (const id of created.productIds) {
      await sql`DELETE FROM inventory WHERE product_id = ${id}`;
      await sql`DELETE FROM product_categories WHERE product_id = ${id}`;
      await sql`DELETE FROM products WHERE id = ${id}`;
    }
    for (const id of created.categoryIds) {
      await sql`DELETE FROM categories WHERE id = ${id}`;
    }
    if (closeSql) await closeSql();
  });

  it('quoteCart считает итог из каталога (anti-tamper, цены не из запроса)', async () => {
    const productId = await makeProduct({ basePrice: '500.00', quantity: 10 });
    const res = await repo.quoteCart({ items: [{ productId, qty: 2 }] });
    expect(res.quote.itemsTotal).toBe('1000.00');
    expect(res.quote.grandTotal).toBe('1000.00');
    expect(res.fulfillable).toBe(true);
    expect(res.issues).toHaveLength(0);
  });

  it('quoteCart помечает нехватку остатка без создания заказа', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 1 });
    const res = await repo.quoteCart({ items: [{ productId, qty: 5 }] });
    expect(res.fulfillable).toBe(false);
    expect(res.issues.some((i) => i.code === 'out_of_stock')).toBe(true);
  });

  it('quoteCart применяет percent-промокод', async () => {
    const productId = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    await makePromo({ code: 'PCT10', kind: 'percent', value: '10' });
    const res = await repo.quoteCart({
      items: [{ productId, qty: 1 }],
      promoCode: 'PCT10',
    });
    expect(res.promo?.valid).toBe(true);
    expect(res.quote.discount).toBe('100.00');
    expect(res.quote.grandTotal).toBe('900.00');
  });

  it('quoteCart применяет bogo «3 по 2» (1 единица из 3 бесплатна)', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 10 });
    await makePromo({
      code: 'BOGO32',
      kind: 'bogo',
      bogoBuyQty: 3,
      bogoPayQty: 2,
      applyScope: 'cart',
    });
    const res = await repo.quoteCart({
      items: [{ productId, qty: 3 }],
      promoCode: 'BOGO32',
    });
    expect(res.promo?.valid).toBe(true);
    // 3 × 100, floor(3/3)=1 группа, бесплатна 1 самая дешёвая → discount 100.
    expect(res.quote.promo.discount).toBe('100.00');
    expect(res.quote.discount).toBe('100.00');
    expect(res.quote.grandTotal).toBe('200.00');
  });

  it('quoteCart: scope=category применяет percent только к товарам категории', async () => {
    const categoryId = await makeCategory();
    const inCat = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    const outCat = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    await linkProductCategory(inCat, categoryId);
    const promoId = await makePromo({
      code: 'CAT10',
      kind: 'percent',
      value: '10',
      applyScope: 'category',
    });
    await addCategoryTarget(promoId, categoryId);

    const res = await repo.quoteCart({
      items: [
        { productId: inCat, qty: 1 },
        { productId: outCat, qty: 1 },
      ],
      promoCode: 'CAT10',
    });
    expect(res.promo?.valid).toBe(true);
    // 10% только от товара в категории (1000) = 100; товар вне scope не дисконтируется.
    expect(res.quote.discount).toBe('100.00');
    expect(res.quote.itemsTotal).toBe('2000.00');
    expect(res.quote.grandTotal).toBe('1900.00');
  });

  it('createOrder пишет реальный discount_applied (рубли через fromMinor) для bogo + инкремент used_count', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 10 });
    const promoId = await makePromo({
      code: 'BOGOORDER',
      kind: 'bogo',
      bogoBuyQty: 3,
      bogoPayQty: 2,
      applyScope: 'cart',
    });
    const r = await repo.createOrder({
      items: [{ productId, qty: 3 }],
      customer: customer(),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
      promoCode: 'BOGOORDER',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.orderIds.push(r.order.id);

    // discount_total в рублях (numeric), не копейки.
    expect(r.order.discountTotal).toBe('100.00');
    expect(r.order.grandTotal).toBe('200.00');

    // promo_redemptions.discount_applied — рубли через fromMinor.
    const [red] = await sql<{ discount_applied: string }[]>`
      SELECT discount_applied FROM promo_redemptions WHERE order_id = ${r.order.id}
    `;
    expect(red!.discount_applied).toBe('100.00');

    // used_count инкрементирован атомарно.
    const [pc] = await sql<{ used_count: number }[]>`
      SELECT used_count FROM promo_codes WHERE id = ${promoId}
    `;
    expect(Number(pc!.used_count)).toBe(1);
  });

  // БАГ A волны 7: scoped percent-промокод minQty=3, в scope 2 единицы (+5 вне
  // scope). Раньше validatePromo брал кол-во ВСЕЙ корзины (7 ≥ 3) → valid, но
  // pricing считал minQty по SCOPED-кол-ву (2 < 3) → discount=0, при этом
  // used_count бампался и писался redemption с '0.00'. Теперь minQty сверяется со
  // scoped-кол-вом → valid=false, заказ отказывает, лимит НЕ потребляется.
  it('createOrder: scoped minQty не достигнут по scope → invalid_promo, used_count и redemption НЕ пишутся (баг A)', async () => {
    const categoryId = await makeCategory();
    const inCat = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    const outCat = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    await linkProductCategory(inCat, categoryId);
    const promoId = await makePromo({
      code: 'SCOPEMIN3',
      kind: 'percent',
      value: '10',
      applyScope: 'category',
      minQty: 3,
    });
    await addCategoryTarget(promoId, categoryId);

    // 2 единицы в scope + 5 вне scope: корзина = 7, scope = 2 < minQty=3.
    const r = await repo.createOrder({
      items: [
        { productId: inCat, qty: 2 },
        { productId: outCat, qty: 5 },
      ],
      customer: customer('scopemin@example.com'),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
      promoCode: 'SCOPEMIN3',
    });
    expect(r.ok).toBe(false);
    if (r.ok) {
      created.orderIds.push(r.order.id);
      return;
    }
    expect(r.code).toBe('invalid_promo');

    // Лимит НЕ потреблён: used_count остался 0, redemption не вставлен.
    const [pc] = await sql<{ used_count: number }[]>`
      SELECT used_count FROM promo_codes WHERE id = ${promoId}
    `;
    expect(Number(pc!.used_count)).toBe(0);
    const reds = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM promo_redemptions WHERE promo_code_id = ${promoId}
    `;
    expect(Number(reds[0]!.n)).toBe(0);
  });

  // Регресс: scope=cart minQty считается по totalQty (всей корзине) — поведение
  // не изменилось. Корзина 3 ед. ⇒ minQty=3 достигнут ⇒ скидка применяется.
  it('createOrder: cart-scope minQty по totalQty работает как раньше (баг A — регресс)', async () => {
    const productId = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    const promoId = await makePromo({
      code: 'CARTMIN3',
      kind: 'percent',
      value: '10',
      applyScope: 'cart',
      minQty: 3,
    });
    const r = await repo.createOrder({
      items: [{ productId, qty: 3 }],
      customer: customer('scopemin@example.com'),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
      promoCode: 'CARTMIN3',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.orderIds.push(r.order.id);

    // 10% от 3000 = 300; лимит потреблён (реальный эффект).
    expect(r.order.discountTotal).toBe('300.00');
    const [pc] = await sql<{ used_count: number }[]>`
      SELECT used_count FROM promo_codes WHERE id = ${promoId}
    `;
    expect(Number(pc!.used_count)).toBe(1);
    const [red] = await sql<{ discount_applied: string }[]>`
      SELECT discount_applied FROM promo_redemptions WHERE order_id = ${r.order.id}
    `;
    expect(red!.discount_applied).toBe('300.00');
  });

  it('anti-tamper: scope определяется сервером из каталога (товар вне категории не дисконтируется)', async () => {
    const categoryId = await makeCategory();
    const outCat = await makeProduct({ basePrice: '500.00', quantity: 10 });
    const promoId = await makePromo({
      code: 'CATANTI',
      kind: 'percent',
      value: '50',
      applyScope: 'category',
    });
    await addCategoryTarget(promoId, categoryId);

    // Товар НЕ привязан к категории-таргету → скидки быть не должно.
    const res = await repo.quoteCart({
      items: [{ productId: outCat, qty: 1 }],
      promoCode: 'CATANTI',
    });
    expect(res.promo?.valid).toBe(true);
    expect(res.quote.discount).toBe('0.00');
    expect(res.quote.promo.applied).toBe(false);
  });

  it('createOrder: резерв, номер, снимок позиций, история', async () => {
    const productId = await makeProduct({ basePrice: '250.00', quantity: 5 });
    const r = await repo.createOrder({
      items: [{ productId, qty: 2 }],
      customer: customer(),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.orderIds.push(r.order.id);

    expect(r.order.number).toMatch(/\d{4}-\d{6}$/);
    expect(r.order.itemsTotal).toBe('500.00');
    expect(r.order.status).toBe('new');

    // Резерв увеличился на 2.
    const [inv] = await sql<{ reserved: number }[]>`
      SELECT reserved FROM inventory WHERE product_id = ${productId} AND warehouse_code = 'main'
    `;
    expect(Number(inv!.reserved)).toBe(2);

    // Позиции (снимок).
    const detail = await repo.getOrderById(r.order.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0]?.unitPrice).toBe('250.00');
    expect(detail?.items[0]?.lineTotal).toBe('500.00');

    // История.
    const hist = await sql<{ to_status: string }[]>`
      SELECT to_status FROM order_status_history WHERE order_id = ${r.order.id}
    `;
    expect(hist.map((h) => h.to_status)).toContain('new');
  });

  it('createOrder идемпотентен по idempotency_key (не дублирует)', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 10 });
    const key = 'idem-' + Math.random().toString(36).slice(2);
    const args = {
      items: [{ productId, qty: 1 }],
      customer: customer(),
      delivery: { type: 'courier' as const },
      paymentMethod: 'cod' as const,
      idempotencyKey: key,
    };
    const a = await repo.createOrder(args);
    const b = await repo.createOrder(args);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) created.orderIds.push(a.order.id);
    if (a.ok && b.ok) {
      expect(b.reused).toBe(true);
      expect(b.order.id).toBe(a.order.id);
    }
    // Резерв списан ровно один раз (1), не два.
    const [inv] = await sql<{ reserved: number }[]>`
      SELECT reserved FROM inventory WHERE product_id = ${productId} AND warehouse_code = 'main'
    `;
    expect(Number(inv!.reserved)).toBe(1);
  });

  it('гонка идемпотентности: два параллельных createOrder с одним ключом → один заказ (BUG #2)', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 10 });
    const key = 'idem-race-' + Math.random().toString(36).slice(2);
    const args = {
      items: [{ productId, qty: 1 }],
      customer: customer(),
      delivery: { type: 'courier' as const },
      paymentMethod: 'cod' as const,
      idempotencyKey: key,
    };
    // Параллельно: один вставит, второй нарвётся на UNIQUE orders_idempotency_uniq
    // (23505) и ДОЛЖЕН вернуть существующий заказ (reused), а не упасть с 500.
    const [a, b] = await Promise.all([repo.createOrder(args), repo.createOrder(args)]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) created.orderIds.push(a.order.id);
    if (a.ok && b.ok) {
      // Оба ссылаются на один и тот же заказ.
      expect(b.order.id).toBe(a.order.id);
      // Ровно один реально создал, второй — идемпотентный повтор.
      expect(a.reused !== b.reused).toBe(true);
    }
    // Резерв списан ровно один раз (анти-дубль).
    const [inv] = await sql<{ reserved: number }[]>`
      SELECT reserved FROM inventory WHERE product_id = ${productId} AND warehouse_code = 'main'
    `;
    expect(Number(inv!.reserved)).toBe(1);
    // В БД ровно одна строка с этим ключом.
    const [cnt] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM orders WHERE idempotency_key = ${key}
    `;
    expect(Number(cnt!.n)).toBe(1);
  });

  it('createOrder отклоняет при нехватке остатка', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 1 });
    const r = await repo.createOrder({
      items: [{ productId, qty: 3 }],
      customer: customer(),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('out_of_stock');
  });

  // BUG A (CRITICAL, anti-undercharge): доставка должна считаться по РЕАЛЬНОМУ весу
  // из каталога (resolveLineDims → order_items.weight_g), а не по дефолту магазина.
  // Раньше resolveDeliveryCost отбрасывал weightG → и quote, и createOrder билили
  // по дефолту (≈500 г), а реальная СДЭК-накладная — по реальному весу: undercharge.
  describe('BUG A: доставка считается по реальному весу (anti-undercharge)', () => {
    const ORIG_MODULES = process.env.ADMIK_MODULES;
    const ORIG_ACC = process.env.CDEK_ACCOUNT;
    const ORIG_SEC = process.env.CDEK_SECRET;

    beforeAll(() => {
      // Модуль cdek включён + mock-режим (без боевых ключей): courier триггерит
      // расчёт по весу (door-формула §5.3), детерминированный, без сети.
      process.env.ADMIK_MODULES = 'catalog,orders,cdek';
      delete process.env.CDEK_ACCOUNT;
      delete process.env.CDEK_SECRET;
    });
    afterAll(() => {
      if (ORIG_MODULES === undefined) delete process.env.ADMIK_MODULES;
      else process.env.ADMIK_MODULES = ORIG_MODULES;
      if (ORIG_ACC === undefined) delete process.env.CDEK_ACCOUNT;
      else process.env.CDEK_ACCOUNT = ORIG_ACC;
      if (ORIG_SEC === undefined) delete process.env.CDEK_SECRET;
      else process.env.CDEK_SECRET = ORIG_SEC;
    });

    it('quote/createOrder/Calculator дают ОДИНАКОВУЮ доставку по реальному весу 5кг', async () => {
      const weightG = 5000; // тяжёлый товар: дефолтный путь дал бы дешевле
      const productId = await makeProduct({ basePrice: '1000.00', quantity: 10, weightG });
      const delivery = { type: 'courier' as const, city: 'Москва' };

      // 1) Эталон: прямой расчёт СДЭК по реальному весу. Зеркалит ровно то, что
      // делает computeDeliveryCost для КУРЬЕРА: тариф склад-дверь (doorTariffCode 137,
      // M4-полнота), назначение строкой города (address). Раньше курьер считался по
      // ПВЗ-тарифу 136 (undercharge) — теперь по 137 с курьерской надбавкой.
      const { Calculator } = await import('@/lib/cdek/services/calculator');
      const { getCdekManager } = await import('@/lib/cdek/manager');
      const mgr = getCdekManager();
      const calc = new Calculator(mgr);
      const expected = await calc.calculate({
        to: { address: 'Москва' },
        lines: [{ qty: 1, weightG }],
        tariffCode: mgr.config.doorTariffCode,
      });
      // 5000 г → 5 кг по тарифу склад-дверь 137: 300 + 100*5 + 150 (курьерская
      // надбавка) = 950 (≠ 800 по ПВЗ-136 — устранён недотариф курьера, M4-полнота).
      expect(expected.deliverySum).toBe('950.00');

      // 2) quote: доставка совпадает с эталоном по реальному весу.
      const q = await repo.quoteCart({ items: [{ productId, qty: 1 }], delivery });
      expect(q.deliveryResolved).toBe(true);
      expect(q.quote.deliveryCost).toBe(expected.deliverySum);

      // 3) createOrder: delivery_total/order_items.weight_g согласованы с эталоном.
      const r = await repo.createOrder({
        items: [{ productId, qty: 1 }],
        customer: customer(),
        delivery,
        paymentMethod: 'cod',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      created.orderIds.push(r.order.id);
      expect(r.order.deliveryTotal).toBe(expected.deliverySum);

      // order_items.weight_g несёт РЕАЛЬНЫЙ вес — тот же, по которому считали.
      const [oi] = await sql<{ weight_g: number | null }[]>`
        SELECT weight_g FROM order_items WHERE order_id = ${r.order.id} LIMIT 1
      `;
      expect(Number(oi!.weight_g)).toBe(weightG);
    });
  });

  // BUG C (консистентность quote↔createOrder): две линии ОДНОГО юнита по qty
  // каждая. Полинейная проверка пропускала (available >= qty на линию), но резерв
  // createOrder кумулятивен (вторая линия падает). Quote теперь агрегирует спрос
  // по юниту → fulfillable=false там же, где createOrder вернёт out_of_stock.
  it('BUG C: quote с двумя линиями одного юнита при остатке < суммы → fulfillable=false', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 3 });
    // Спрос 2+2=4 > остаток 3 (но каждая линия по 2 <= 3 — старый полинейный
    // путь дал бы fulfillable=true и рассогласование с createOrder).
    const items = [
      { productId, qty: 2 },
      { productId, qty: 2 },
    ];
    const q = await repo.quoteCart({ items });
    expect(q.fulfillable).toBe(false);
    expect(q.issues.some((i) => i.code === 'out_of_stock')).toBe(true);

    // Согласованность: createOrder на тот же ввод тоже отклоняет (out_of_stock).
    const r = await repo.createOrder({
      items,
      customer: customer(),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('out_of_stock');
  });

  it('BUG C: две линии одного юнита, сумма <= остатка → fulfillable=true (не ломаем)', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 5 });
    const q = await repo.quoteCart({
      items: [
        { productId, qty: 2 },
        { productId, qty: 2 },
      ],
    });
    expect(q.fulfillable).toBe(true);
    expect(q.issues).toHaveLength(0);
  });

  it('гонка резерва: только один из двух параллельных заказов на последний остаток', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 1 });
    const mk = () =>
      repo.createOrder({
        items: [{ productId, qty: 1 }],
        customer: customer('race@example.com'),
        delivery: { type: 'courier' },
        paymentMethod: 'cod',
      });
    const [a, b] = await Promise.all([mk(), mk()]);
    const oks = [a, b].filter((x) => x.ok);
    expect(oks).toHaveLength(1);
    for (const x of [a, b]) if (x.ok) created.orderIds.push(x.order.id);

    const [inv] = await sql<{ reserved: number; quantity: number }[]>`
      SELECT reserved, quantity FROM inventory WHERE product_id = ${productId} AND warehouse_code = 'main'
    `;
    expect(Number(inv!.reserved)).toBe(1);
  });

  it('лимит промокода: usage_limit исчерпывается, второй заказ отклоняется', async () => {
    const productId = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    await makePromo({ code: 'ONCE', kind: 'fixed', value: '100.00', usageLimit: 1 });
    const mk = () =>
      repo.createOrder({
        items: [{ productId, qty: 1 }],
        customer: customer('limit@example.com'),
        delivery: { type: 'courier' },
        paymentMethod: 'cod',
        promoCode: 'ONCE',
      });
    const a = await mk();
    expect(a.ok).toBe(true);
    if (a.ok) created.orderIds.push(a.order.id);
    const b = await mk();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('invalid_promo');
  });

  it('per_customer_limit: второй заказ того же покупателя отклоняется (последовательно)', async () => {
    const productId = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    await makePromo({
      code: 'PERCUST1',
      kind: 'fixed',
      value: '100.00',
      perCustomerLimit: 1,
    });
    const mk = () =>
      repo.createOrder({
        items: [{ productId, qty: 1 }],
        customer: customer('percust@example.com'),
        delivery: { type: 'courier' },
        paymentMethod: 'cod',
        promoCode: 'PERCUST1',
      });
    const a = await mk();
    expect(a.ok).toBe(true);
    if (a.ok) created.orderIds.push(a.order.id);
    const b = await mk();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('invalid_promo');
  });

  it('per_customer_limit: гонка двух одновременных чекаутов одного email — проходит ровно один (N1)', async () => {
    const productId = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    await makePromo({
      code: 'PERCUSTRACE',
      kind: 'fixed',
      value: '100.00',
      perCustomerLimit: 1,
    });
    const mk = () =>
      repo.createOrder({
        items: [{ productId, qty: 1 }],
        customer: customer('percustrace@example.com'),
        delivery: { type: 'courier' },
        paymentMethod: 'cod',
        promoCode: 'PERCUSTRACE',
      });
    const [a, b] = await Promise.all([mk(), mk()]);
    const oks = [a, b].filter((x) => x.ok);
    // Ровно один заказ проходит, второй отклонён по per_customer_limit.
    expect(oks).toHaveLength(1);
    for (const x of [a, b]) if (x.ok) created.orderIds.push(x.order.id);
    const rejected = [a, b].find((x) => !x.ok);
    if (rejected && !rejected.ok) expect(rejected.code).toBe('invalid_promo');
  });

  it('createOrder выдаёт подарок (gift_*) строкой is_gift с ценой 0 + резервирует подарок (ADR-016)', async () => {
    const buyProduct = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    const giftProduct = await makeProduct({ basePrice: '300.00', quantity: 5 });
    await makePromo({
      code: 'GIFTPROMO',
      kind: 'fixed',
      value: '100.00',
      giftProductId: giftProduct,
      giftQty: 1,
    });
    const r = await repo.createOrder({
      items: [{ productId: buyProduct, qty: 1 }],
      customer: customer('gift@example.com'),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
      promoCode: 'GIFTPROMO',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.orderIds.push(r.order.id);

    // Подарок — отдельная строка is_gift, цена и сумма 0, qty=1.
    const detail = await repo.getOrderById(r.order.id);
    const gift = detail?.items.find((i) => i.isGift);
    expect(gift).toBeTruthy();
    expect(gift?.unitPrice).toBe('0.00');
    expect(gift?.lineTotal).toBe('0.00');
    expect(gift?.quantity).toBe(1);
    // Обычная позиция осталась платной.
    expect(detail?.items.filter((i) => !i.isGift)).toHaveLength(1);

    // Подарок зарезервирован (анти-оверселл).
    const [inv] = await sql<{ reserved: number }[]>`
      SELECT reserved FROM inventory WHERE product_id = ${giftProduct} AND warehouse_code = 'main'
    `;
    expect(Number(inv!.reserved)).toBe(1);

    // Итог НЕ включает подарок: 1000 − 100 скидки + 0 = 900.
    expect(r.order.itemsTotal).toBe('1000.00');
    expect(r.order.discountTotal).toBe('100.00');
    expect(r.order.grandTotal).toBe('900.00');
  });

  it('C6-3: gift-only промокод (0 скидки) + подарок БЕЗ остатка → лимит НЕ съедается (used_count=0, нет redemption)', async () => {
    // Промокод только с подарком (нулевая денежная скидка → quote.promo.applied=false).
    // Подарок без остатка → best-effort резерв не проходит → эффекта нет → лимит НЕ
    // должен расходоваться. Прежде promoHadEffect считался по giftLine!=null (до резерва)
    // → клиент жёг per_customer_limit, не получив ни скидки, ни подарка (C6-3).
    const buyProduct = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    const giftProduct = await makeProduct({ basePrice: '300.00', quantity: 0 }); // НЕТ остатка
    const promoId = await makePromo({
      code: 'GIFTONLY0',
      kind: 'fixed',
      value: '0', // нулевая скидка: единственный заявленный эффект — подарок
      giftProductId: giftProduct,
      giftQty: 1,
      perCustomerLimit: 1,
    });
    const r = await repo.createOrder({
      items: [{ productId: buyProduct, qty: 1 }],
      customer: customer('giftnostock@example.com'),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
      promoCode: 'GIFTONLY0',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.orderIds.push(r.order.id);

    // Подарок НЕ выдан (нет остатка) → нет gift-строки.
    const detail = await repo.getOrderById(r.order.id);
    expect(detail?.items.some((i) => i.isGift)).toBe(false);

    // Нулевой эффект (нет скидки, подарок не выдан) → лимит НЕ потреблён.
    const [pc] = await sql<{ used_count: number }[]>`
      SELECT used_count FROM promo_codes WHERE id = ${promoId}
    `;
    expect(Number(pc!.used_count)).toBe(0);
    const [red] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM promo_redemptions WHERE promo_code_id = ${promoId}
    `;
    expect(Number(red!.n)).toBe(0);
  });

  it('createOrder: подарок без остатка → заказ создаётся БЕЗ подарка (best-effort)', async () => {
    const buyProduct = await makeProduct({ basePrice: '1000.00', quantity: 10 });
    const giftProduct = await makeProduct({ basePrice: '300.00', quantity: 0 });
    await makePromo({
      code: 'GIFTNOSTOCK',
      kind: 'fixed',
      value: '100.00',
      giftProductId: giftProduct,
      giftQty: 1,
    });
    const r = await repo.createOrder({
      items: [{ productId: buyProduct, qty: 1 }],
      customer: customer('gift@example.com'),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
      promoCode: 'GIFTNOSTOCK',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.orderIds.push(r.order.id);
    // Подарок не выдан, заказ создан и оплачиваем.
    const detail = await repo.getOrderById(r.order.id);
    expect(detail?.items.some((i) => i.isGift)).toBe(false);
    expect(detail?.items).toHaveLength(1);
  });

  it('commitReservation/releaseReservation двигают остаток корректно', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 10, reserved: 0 });
    // Резерв 3.
    await sql.begin(async (tx) => {
      const ok = await repo.reserveUnit(tx, { productId, variantId: null, qty: 3 });
      expect(ok).toBe(true);
    });
    // Списание (отгрузка) 2: quantity 10→8, reserved 3→1.
    await sql.begin(async (tx) => {
      await repo.commitReservation(tx, { productId, variantId: null, qty: 2 });
    });
    // Возврат резерва 1: reserved 1→0.
    await sql.begin(async (tx) => {
      await repo.releaseReservation(tx, { productId, variantId: null, qty: 1 });
    });
    const [inv] = await sql<{ reserved: number; quantity: number }[]>`
      SELECT reserved, quantity FROM inventory WHERE product_id = ${productId} AND warehouse_code = 'main'
    `;
    expect(Number(inv!.quantity)).toBe(8);
    expect(Number(inv!.reserved)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Guarded-UPDATE статуса (Fix 1, TOCTOU) — контракт слоя данных на ЖИВОЙ БД.
  //
  // applyOrderStatusTransition (actions.ts) опирается на guarded UPDATE
  // `UPDATE orders SET status WHERE id AND status = from RETURNING id`: переход
  // применяется только если статус не сменился конкурентно. Здесь проверяем САМ
  // этот SQL-инвариант (а не пайплайн action): из двух параллельных переходов из
  // одного `from` ровно один меняет строку (RETURNING 1), второй — 0 строк.
  // ---------------------------------------------------------------------------
  it('guarded UPDATE статуса: из двух параллельных переходов new→paid проходит ровно один (TOCTOU)', async () => {
    const productId = await makeProduct({ basePrice: '100.00', quantity: 10 });
    const r = await repo.createOrder({
      items: [{ productId, qty: 1 }],
      customer: customer(),
      delivery: { type: 'courier' },
      paymentMethod: 'cod',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.orderIds.push(r.order.id);
    const orderId = r.order.id;

    // Два конкурентных guarded UPDATE из одного и того же `from='new'`.
    const guardedUpdate = () =>
      sql<{ id: string }[]>`
        UPDATE orders
           SET status = 'paid', updated_at = now()
         WHERE id = ${orderId} AND status = 'new'
        RETURNING id
      `;
    const [a, b] = await Promise.all([guardedUpdate(), guardedUpdate()]);
    const winners = [a, b].filter((rows) => rows.length === 1);
    // Ровно один перевёл статус; второй увидел уже изменённый статус → 0 строк.
    expect(winners).toHaveLength(1);

    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM orders WHERE id = ${orderId}
    `;
    expect(row!.status).toBe('paid');
  });

  // ---------------------------------------------------------------------------
  // listActivePromotions (волна 14): промокод с исчерпанным usage_limit
  // (used_count >= usage_limit) НЕ попадает в публичный список акций. Иначе
  // витрина показывала бы бейдж «акция» по коду, который уже нельзя применить
  // (createOrder отклонит как invalid_promo) — рассинхрон UI и фактического
  // расчёта. Условие фильтра: usage_limit IS NULL OR used_count < usage_limit.
  // ---------------------------------------------------------------------------
  describe('listActivePromotions: исключает исчерпанный usage_limit', () => {
    /** Создаёт промокод и доводит used_count до нужного значения. */
    async function makePromoWithUsed(over: {
      code: string;
      usageLimit: number | null;
      usedCount: number;
    }): Promise<string> {
      const id = await makePromo({
        code: over.code,
        kind: 'fixed',
        value: '100.00',
        usageLimit: over.usageLimit,
      });
      if (over.usedCount > 0) {
        await sql`UPDATE promo_codes SET used_count = ${over.usedCount} WHERE id = ${id}`;
      }
      return id;
    }

    it('used_count >= usage_limit → НЕ в списке; null-лимит и used_count<limit → в списке', async () => {
      const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
      const exhausted = await makePromoWithUsed({
        code: `EXH-${suffix}`,
        usageLimit: 2,
        usedCount: 2, // исчерпан (>= лимита)
      });
      const unlimited = await makePromoWithUsed({
        code: `UNL-${suffix}`,
        usageLimit: null, // безлимит → всегда активен
        usedCount: 999,
      });
      const available = await makePromoWithUsed({
        code: `AVL-${suffix}`,
        usageLimit: 5,
        usedCount: 4, // ещё есть запас (4 < 5)
      });

      const list = await repo.listActivePromotions();
      const ids = list.map((p) => p.promo.id);

      expect(ids).not.toContain(exhausted); // исчерпанный скрыт
      expect(ids).toContain(unlimited); // безлимитный показан
      expect(ids).toContain(available); // с запасом показан
    });
  });
});
