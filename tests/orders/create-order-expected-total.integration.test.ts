import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — СЕРВЕРНАЯ сверка ожидаемого итога.
 * Аудит 2026-07-26, находки major №2 и major №9.
 *
 * Клиент — не защита: сверку обязан делать сервер. Проверяем, что при передаче
 * НЕОБЯЗАТЕЛЬНОГО `expectedGrandTotal` createOrder:
 *   • пропускает заказ, когда ожидаемый итог совпал с фактическим;
 *   • ОТКАЗЫВАЕТ (`total_mismatch`) и НЕ создаёт заказ, когда итог разошёлся —
 *     в т.ч. по сценарию №9 (сертификат покрыл МЕНЬШЕ, чем показала витрина);
 *   • НЕ выполняет сверку, когда поле не прислано (старый клиент, аддитивность);
 *   • сверяет и на ПЕРЕИСПОЛЬЗОВАННОМ заказе (сценарий №2: тот же
 *     Idempotency-Key после смены состава → reused-заказ со старыми суммами
 *     обязан быть отвергнут, а не отдан покупателю на оплату).
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)(
  'createOrder — серверная сверка expectedGrandTotal (интеграция, нужна БД)',
  () => {
    let repo: typeof import('@/lib/orders/repository');
    let sql: typeof import('@/lib/db/client').sql;
    let closeSql: typeof import('@/lib/db/client').closeSql;

    const created = {
      productIds: [] as string[],
      certIds: [] as string[],
      orderEmails: new Set<string>(),
    };

    async function makeProduct(basePrice: string, quantity = 100): Promise<string> {
      const s = Math.random().toString(36).slice(2, 10);
      const [p] = await sql<{ id: string }[]>`
        INSERT INTO products (sku, slug, name, status, base_price)
        VALUES (${'ET-' + s}, ${'et-' + s}, ${'ExpectedTotal ' + s}, 'active', ${basePrice})
        RETURNING id
      `;
      created.productIds.push(p!.id);
      await sql`
        INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
        VALUES (${p!.id}, NULL, 'main', ${quantity}, 0)
      `;
      return p!.id;
    }

    async function makeCert(initial: string): Promise<{ id: string; code: string }> {
      const code = 'ETG-' + Math.random().toString(36).slice(2, 10).toUpperCase();
      const [c] = await sql<{ id: string }[]>`
        INSERT INTO gift_certificates (code, initial_amount, status, valid_until)
        VALUES (${code}, ${initial}, 'active', NULL)
        RETURNING id
      `;
      created.certIds.push(c!.id);
      return { id: c!.id, code };
    }

    function customer(email: string) {
      created.orderEmails.add(email);
      return { name: 'Покупатель', email, phone: '+70000000000' };
    }

    async function orderCount(email: string): Promise<number> {
      const [r] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM orders WHERE customer_email = ${email}
      `;
      return Number(r!.n);
    }

    beforeAll(async () => {
      repo = await import('@/lib/orders/repository');
      const db = await import('@/lib/db/client');
      sql = db.sql;
      closeSql = db.closeSql;
    });

    afterAll(async () => {
      for (const email of created.orderEmails) {
        await sql`DELETE FROM orders WHERE customer_email = ${email}`;
      }
      for (const id of created.certIds) {
        await sql`DELETE FROM gift_certificates WHERE id = ${id}`;
      }
      for (const id of created.productIds) {
        await sql`DELETE FROM inventory WHERE product_id = ${id}`;
        await sql`DELETE FROM products WHERE id = ${id}`;
      }
      if (closeSql) await closeSql();
    });

    it('совпало: expectedGrandTotal = фактический итог → заказ создан', async () => {
      const productId = await makeProduct('500.00');
      const r = await repo.createOrder({
        items: [{ productId, qty: 2 }],
        customer: customer('et-match@example.com'),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        expectedGrandTotal: '1000.00',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.order.grandTotal).toBe('1000.00');
    });

    it('🔴 разошлось: отказ total_mismatch и заказ НЕ создан', async () => {
      const productId = await makeProduct('500.00');
      const email = 'et-mismatch@example.com';
      const r = await repo.createOrder({
        items: [{ productId, qty: 2 }],
        customer: customer(email),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        // Покупатель видел 800 (напр. ожидал скидку), фактически выходит 1000.
        expectedGrandTotal: '800.00',
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('total_mismatch');
      // Заказа в БД нет — молчаливого создания «по своей цене» не произошло.
      expect(await orderCount(email)).toBe(0);
    });

    it('сверка по КОПЕЙКАМ: "1000" и "1000.00" — одна и та же сумма', async () => {
      const productId = await makeProduct('500.00');
      const r = await repo.createOrder({
        items: [{ productId, qty: 2 }],
        customer: customer('et-scale@example.com'),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        expectedGrandTotal: '1000',
      });
      expect(r.ok).toBe(true);
    });

    it('🔴 АДДИТИВНОСТЬ: без поля сверки нет — старый клиент работает как раньше', async () => {
      const productId = await makeProduct('500.00');
      const r = await repo.createOrder({
        items: [{ productId, qty: 2 }],
        customer: customer('et-legacy@example.com'),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.order.grandTotal).toBe('1000.00');
    });

    /**
     * НАХОДКА №9: витрина показала «сертификат покрывает весь заказ» (ожидаемый
     * итог 0), но к моменту createOrder остаток сертификата уже потрачен
     * параллельным заказом — сервер покрывает МЕНЬШЕ и итог ненулевой.
     * Раньше заказ молча создавался и покупателя вели платить неожиданную сумму.
     */
    it('🔴 №9: сертификат покрыл меньше показанного → total_mismatch, а не тихий заказ', async () => {
      const productId = await makeProduct('300.00');
      // Номинал 500: хватает и на «весь заказ 300» (как видел покупатель), и на
      // ЧАСТИЧНОЕ покрытие после параллельной траты. Сертификат обязан остаться
      // ВАЛИДНЫМ (не исчерпан, не истёк) — иначе сработал бы более ранний отказ
      // invalid_gift и находка №9 осталась бы непроверенной: её суть именно в ТИХОМ
      // создании заказа ВАЛИДНЫМ сертификатом с УМЕНЬШИВШИМСЯ покрытием.
      const cert = await makeCert('500.00');

      // Параллельный заказ съедает 400 из 500 — остаётся 100 (сертификат ещё живой).
      const drainProductId = await makeProduct('400.00');
      const first = await repo.createOrder({
        items: [{ productId: drainProductId, qty: 1 }],
        customer: customer('et-gift-first@example.com'),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        giftCertificateCode: cert.code,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.order.grandTotal).toBe('0.00');

      // Покупатель ВИДЕЛ «сертификат покрывает весь заказ» (итог 0: на момент quote
      // остаток был 500), но к оформлению остаток уже 100 → фактический итог 200.
      const email = 'et-gift-second@example.com';
      const second = await repo.createOrder({
        items: [{ productId, qty: 1 }],
        customer: customer(email),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        giftCertificateCode: cert.code,
        expectedGrandTotal: '0.00',
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.code).toBe('total_mismatch');
      expect(await orderCount(email)).toBe(0);
    });

    /**
     * НАХОДКА №2: повторный submit с ТЕМ ЖЕ Idempotency-Key после смены состава.
     * Сервер возвращает reused-заказ со СТАРЫМИ суммами. Сверка обязана поймать
     * это и ДО того, как покупателя увели платить старую сумму.
     */
    it('🔴 №2: reused-заказ со старой суммой отвергается по expectedGrandTotal', async () => {
      const productId = await makeProduct('600.00');
      const key = 'et-idem-' + Math.random().toString(36).slice(2, 12);
      const email = 'et-reuse@example.com';

      // Первая попытка: заказ на 1200 создан (init оплаты «упал» — вне БД).
      const first = await repo.createOrder({
        items: [{ productId, qty: 2 }],
        customer: customer(email),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        idempotencyKey: key,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.order.grandTotal).toBe('1200.00');

      // Вторая попытка тем же ключом, но покупатель на экране видит 960 (промокод).
      const second = await repo.createOrder({
        items: [{ productId, qty: 2 }],
        customer: customer(email),
        delivery: { type: 'pickup' },
        paymentMethod: 'cod',
        idempotencyKey: key,
        expectedGrandTotal: '960.00',
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.code).toBe('total_mismatch');
      // Дубля не появилось — идемпотентность НЕ сломана, просто отказ вместо выдачи.
      expect(await orderCount(email)).toBe(1);
    });

    it('идемпотентность цела: тот же ключ + тот же ожидаемый итог → тот же заказ (reused)', async () => {
      const productId = await makeProduct('700.00');
      const key = 'et-idem-ok-' + Math.random().toString(36).slice(2, 12);
      const email = 'et-reuse-ok@example.com';
      const body = {
        items: [{ productId, qty: 1 }],
        customer: customer(email),
        delivery: { type: 'pickup' as const },
        paymentMethod: 'cod' as const,
        idempotencyKey: key,
        expectedGrandTotal: '700.00',
      };
      const first = await repo.createOrder(body);
      const second = await repo.createOrder(body);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.reused).toBe(true);
      expect(second.order.id).toBe(first.order.id);
      expect(await orderCount(email)).toBe(1);
    });
  },
);
