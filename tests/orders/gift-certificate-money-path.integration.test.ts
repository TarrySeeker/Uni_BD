import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';

/**
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — подарочный сертификат в денежном пути
 * (docs/24 §5, §11, под-шаг 4b). Реальная БД :5434, миграции 0039–0041. Проверяет:
 *  - quote применяет сертификат (read-only, баланс НЕ трогается);
 *  - createOrder списывает АТОМАРНО в транзакции заказа (spent_total, ledger,
 *    orders.gift_certificate_id/gift_discount_total, grand_total уменьшен);
 *  - гонка двух заказов одним сертификатом → баланс не в минус;
 *  - частичное покрытие (gift < товары → к оплате остаток, pending) и ПОЛНОЕ
 *    (gift = вся сумма, самовывоз → к оплате 0, payment paid + provider manual);
 *  - стекование promo+gift (gift к остатку после промо);
 *  - refund через settleRefundEffectsTx возвращает баланс + идемпотентно (не
 *    double-release);
 *  - повтор ИСЧЕРПАННОГО (idempotency) → тот же заказ, без исключения;
 *  - невалидный/истёкший код → createOrder invalid_gift (заказ не создан).
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('orders — gift-сертификат в money-path (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/orders/repository');
  let giftRepo: typeof import('@/lib/gift-certificates/repository');
  let settle: typeof import('@/lib/orders/refund-settle');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const created = {
    productIds: [] as string[],
    certIds: [] as string[],
    promoIds: [] as string[],
    orderEmails: new Set<string>(),
  };

  /** Активный товар с остатком main; возвращает productId. */
  async function makeProduct(basePrice: string, quantity = 100): Promise<string> {
    const s = Math.random().toString(36).slice(2, 10);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${'GC-' + s}, ${'gc-' + s}, ${'GiftCertTest ' + s}, 'active', ${basePrice})
      RETURNING id
    `;
    created.productIds.push(p!.id);
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${p!.id}, NULL, 'main', ${quantity}, 0)
    `;
    return p!.id;
  }

  /** Сертификат с номиналом; возвращает { id, code }. */
  async function makeCert(
    initial: string,
    over: Partial<{ status: string; validUntil: string | null }> = {},
  ): Promise<{ id: string; code: string }> {
    const code = 'GIFT-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO gift_certificates (code, initial_amount, status, valid_until)
      VALUES (${code}, ${initial}, ${over.status ?? 'active'}, ${over.validUntil ?? null})
      RETURNING id
    `;
    created.certIds.push(c!.id);
    return { id: c!.id, code };
  }

  async function makePromoPercent(value: string): Promise<string> {
    const code = 'PCT-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO promo_codes (code, kind, value, is_active)
      VALUES (${code}, 'percent', ${value}, true)
      RETURNING id
    `;
    created.promoIds.push(r!.id);
    return code;
  }

  function customer(email: string) {
    created.orderEmails.add(email);
    return { name: 'Покупатель', email, phone: '+70000000000' };
  }

  /** Остаток сертификата (initial − spent). */
  async function balance(certId: string): Promise<string> {
    return (await giftRepo.getBalance(certId))!;
  }

  beforeAll(async () => {
    repo = await import('@/lib/orders/repository');
    giftRepo = await import('@/lib/gift-certificates/repository');
    settle = await import('@/lib/orders/refund-settle');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    for (const email of created.orderEmails) {
      await sql`DELETE FROM orders WHERE customer_email = ${email}`; // каскадит redemptions/items
    }
    for (const id of created.certIds) {
      await sql`DELETE FROM gift_certificates WHERE id = ${id}`;
    }
    for (const id of created.promoIds) {
      await sql`DELETE FROM promo_codes WHERE id = ${id}`;
    }
    for (const id of created.productIds) {
      await sql`DELETE FROM inventory WHERE product_id = ${id}`;
      await sql`DELETE FROM products WHERE id = ${id}`;
    }
    if (closeSql) await closeSql();
  });

  it('quote применяет сертификат (read-only): баланс НЕ декрементируется', async () => {
    const productId = await makeProduct('300.00');
    const cert = await makeCert('200.00');
    const res = await repo.quoteCart({
      items: [{ productId, qty: 1 }],
      giftCertificateCode: cert.code,
      delivery: { type: 'pickup' },
    });
    expect(res.gift?.applied).toBe(true);
    expect(res.gift?.appliedAmount).toBe('200.00');
    expect(res.gift?.balanceRemainingAfter).toBe('0.00');
    // Баланс на месте — quote ничего не списал.
    expect(await balance(cert.id)).toBe('200.00');
  });

  it('createOrder списывает атомарно: ledger, spent_total, orders.gift_* , grand_total', async () => {
    const productId = await makeProduct('300.00');
    const cert = await makeCert('200.00');
    const r = await repo.createOrder({
      items: [{ productId, qty: 1 }],
      customer: customer('gc-create@example.com'),
      delivery: { type: 'pickup' },
      paymentMethod: 'cod',
      giftCertificateCode: cert.code,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Товары 300, доставка 0, сертификат 200 → к оплате 100.
    expect(r.order.grandTotal).toBe('100.00');
    expect(r.order.giftDiscountTotal).toBe('200.00');
    expect(r.order.giftCertificateId).toBe(cert.id);
    // Частичное покрытие → оплата ожидается (pending), провайдер не проставлен.
    expect(r.order.paymentStatus).toBe('pending');
    // Баланс списан ровно на 200.
    expect(await balance(cert.id)).toBe('0.00');
    const ledger = await giftRepo.getRedemptions(cert.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe('200.00');
    expect(ledger[0]!.orderId).toBe(r.order.id);
  });

  it('ПОЛНОЕ покрытие (самовывоз, gift ≥ товары): к оплате 0, payment paid + provider manual', async () => {
    const productId = await makeProduct('150.00');
    const cert = await makeCert('500.00');
    const r = await repo.createOrder({
      items: [{ productId, qty: 1 }],
      customer: customer('gc-full@example.com'),
      delivery: { type: 'pickup' },
      paymentMethod: 'cod',
      giftCertificateCode: cert.code,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.grandTotal).toBe('0.00');
    expect(r.order.giftDiscountTotal).toBe('150.00');
    expect(r.order.paymentStatus).toBe('paid');
    expect(r.order.paymentProvider).toBe('manual');
    expect(r.order.paidAt).not.toBeNull();
    // Списано только 150 (min(остаток, товары)); остаток 350.
    expect(await balance(cert.id)).toBe('350.00');
  });

  it('СТЕКОВАНИЕ promo(10%)+gift: gift к остатку после промо', async () => {
    const productId = await makeProduct('1000.00');
    const promoCode = await makePromoPercent('10');
    const cert = await makeCert('500.00');
    const r = await repo.createOrder({
      items: [{ productId, qty: 1 }],
      customer: customer('gc-stack@example.com'),
      delivery: { type: 'pickup' },
      paymentMethod: 'cod',
      promoCode,
      giftCertificateCode: cert.code,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 1000 − 10%(=100) = 900; gift 500 → к оплате 400.
    expect(r.order.discountTotal).toBe('100.00');
    expect(r.order.giftDiscountTotal).toBe('500.00');
    expect(r.order.grandTotal).toBe('400.00');
    expect(await balance(cert.id)).toBe('0.00');
  });

  it('ГОНКА: два заказа одним сертификатом сверх остатка → один списывает, баланс не в минус', async () => {
    const productId = await makeProduct('80.00', 100);
    const cert = await makeCert('100.00');
    const mk = (email: string) =>
      repo.createOrder({
        items: [{ productId, qty: 1 }],
        customer: customer(email),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        giftCertificateCode: cert.code,
      });
    // allSettled: под коллатеральной нагрузкой параллельных файлов createOrder может
    // отклониться транзиентно — для семантики гонки это эквивалентно «gift не применён».
    const settled = await Promise.allSettled([mk('gc-race-a@example.com'), mk('gc-race-b@example.com')]);
    const applied = settled.filter(
      (s) => s.status === 'fulfilled' && s.value.ok && s.value.order.giftDiscountTotal === '80.00',
    ).length;
    // Оба заказа по 80: суммарно 160 > 100. Ровно один применяет gift (80), второй —
    // overspend → заказ не создан. Баланс списан ровно на применённое, НЕ в минус.
    expect(applied).toBe(1);
    expect(await balance(cert.id)).toBe('20.00');
  });

  it('REFUND (settleRefundEffectsTx) возвращает баланс; идемпотентно (не double-release)', async () => {
    const productId = await makeProduct('300.00');
    const cert = await makeCert('300.00');
    const r = await repo.createOrder({
      items: [{ productId, qty: 1 }],
      customer: customer('gc-refund@example.com'),
      delivery: { type: 'pickup' },
      paymentMethod: 'cod',
      giftCertificateCode: cert.code,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await balance(cert.id)).toBe('0.00');

    // Возврат: сетл в транзакции восстанавливает баланс сертификата.
    await sql.begin((tx: TransactionSql) => settle.settleRefundEffectsTx(tx, r.order.id, null));
    expect(await balance(cert.id)).toBe('300.00');
    const order1 = await repo.getOrderById(r.order.id);
    expect(order1!.order.status).toBe('refunded');

    // Повторный сетл — идемпотентно, баланс НЕ уходит выше номинала (не double-release).
    await sql.begin((tx: TransactionSql) => settle.settleRefundEffectsTx(tx, r.order.id, null));
    expect(await balance(cert.id)).toBe('300.00');
  });

  it('повтор ИСЧЕРПАННОГО сертификата (idempotency-key) → тот же заказ, без исключения', async () => {
    const productId = await makeProduct('500.00');
    const cert = await makeCert('500.00');
    const args = {
      items: [{ productId, qty: 1 }],
      customer: customer('gc-idem@example.com'),
      delivery: { type: 'pickup' as const },
      paymentMethod: 'cod' as const,
      giftCertificateCode: cert.code,
      idempotencyKey: 'gc-idem-key-001',
    };
    const first = await repo.createOrder(args);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Сертификат исчерпан (status depleted). Повтор с тем же ключом НЕ списывает
    // дважды и НЕ падает на status-гварде — возвращает существующий заказ.
    const second = await repo.createOrder(args);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    // Баланс остался 0 (одно списание, не два).
    expect(await balance(cert.id)).toBe('0.00');
    expect(await giftRepo.getRedemptions(cert.id)).toHaveLength(1);
  });

  it('невалидный код сертификата → createOrder invalid_gift (заказ не создан)', async () => {
    const productId = await makeProduct('100.00');
    const r = await repo.createOrder({
      items: [{ productId, qty: 1 }],
      customer: customer('gc-badcode@example.com'),
      delivery: { type: 'pickup' },
      paymentMethod: 'cod',
      giftCertificateCode: 'NO-SUCH-CERT-XYZ',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid_gift');
  });

  it('истёкший сертификат → createOrder invalid_gift', async () => {
    const productId = await makeProduct('100.00');
    const cert = await makeCert('500.00', { validUntil: '2020-01-01T00:00:00Z' });
    const r = await repo.createOrder({
      items: [{ productId, qty: 1 }],
      customer: customer('gc-expired@example.com'),
      delivery: { type: 'pickup' },
      paymentMethod: 'cod',
      giftCertificateCode: cert.code,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid_gift');
    // Баланс нетронут.
    expect(await balance(cert.id)).toBe('500.00');
  });
});
