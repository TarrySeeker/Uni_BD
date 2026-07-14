import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * ИНТЕГРАЦИЯ (docs/24 §2) — РЕАЛЬНЫЙ round-trip колбэка PayKeeper на живой БД
 * (dev-Postgres :5434, миграции 0037/0038). Проверяет, что recordWebhookEvent
 * действительно ПИШЕТ строку в paykeeper_payment_log под настоящими CHECK/FK/UNIQUE
 * и доводит orders.payment_status до paid.
 *
 * Границы не мокаются — `@/lib/db/client` НАСТОЯЩИЙ. Локально без DATABASE_URL —
 * skipIf пропускает.
 *
 * Инвариант «dev-данные целы»: тест-заказ создаётся с уникальным номером и
 * удаляется в afterAll (FK ON DELETE CASCADE чистит лог платежей).
 */

const hasDb = Boolean(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);

describe.skipIf(!hasDb)('paykeeper/repository — round-trip колбэка (интеграция)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  let recordWebhookEvent: typeof import('@/lib/payments/paykeeper/repository').recordWebhookEvent;
  let setPaymentRefAndProvider: typeof import('@/lib/payments/paykeeper/repository').setPaymentRefAndProvider;
  let findOrderIdByInvoiceId: typeof import('@/lib/payments/paykeeper/repository').findOrderIdByInvoiceId;

  const NUMBER = `PKTEST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const INVOICE_ID = `pk-inv-${Date.now()}`;
  let orderId = '';

  beforeAll(async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    const repo = await import('@/lib/payments/paykeeper/repository');
    recordWebhookEvent = repo.recordWebhookEvent;
    setPaymentRefAndProvider = repo.setPaymentRefAndProvider;
    findOrderIdByInvoiceId = repo.findOrderIdByInvoiceId;

    const rows = await sql<{ id: string }[]>`
      INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone, status, payment_status)
      VALUES (${NUMBER}, '1500.00', '1500.00', 'PK Test', ${`pk-${Date.now()}@example.com`}, '+70000000000', 'new', 'pending')
      RETURNING id
    `;
    orderId = rows[0]!.id;
  });

  afterAll(async () => {
    if (orderId) {
      await sql`DELETE FROM orders WHERE id = ${orderId}`; // cascade → paykeeper_payment_log
    }
    await closeSql();
  });

  it('setPaymentRefAndProvider пишет invoice_id + provider=paykeeper', async () => {
    await setPaymentRefAndProvider(orderId, INVOICE_ID);
    const rows = await sql<{ payment_ref: string; payment_provider: string }[]>`
      SELECT payment_ref, payment_provider FROM orders WHERE id = ${orderId}
    `;
    expect(rows[0]!.payment_ref).toBe(INVOICE_ID);
    expect(rows[0]!.payment_provider).toBe('paykeeper');
    // findOrderIdByInvoiceId резолвит заказ по payment_ref.
    expect(await findOrderIdByInvoiceId(INVOICE_ID)).toBe(orderId);
  });

  it('recordWebhookEvent(PAID) пишет строку лога и доводит payment_status=paid', async () => {
    const res = await recordWebhookEvent({
      log: {
        orderId,
        invoiceId: INVOICE_ID,
        status: 'PAID',
        amountKop: 150000,
        isMock: true,
        rawPayload: { source: 'callback', id: INVOICE_ID, orderid: NUMBER },
      },
      nextStatus: 'paid',
      comment: 'paykeeper-callback:PAID',
    });
    expect(res.inserted).toBe(true);
    expect(res.processed).toBe(true);

    const log = await sql<{ status: string; processed: boolean; amount_kop: string; is_mock: boolean }[]>`
      SELECT status, processed, amount_kop, is_mock FROM paykeeper_payment_log
       WHERE invoice_id = ${INVOICE_ID} AND status = 'PAID'
    `;
    expect(log).toHaveLength(1);
    expect(log[0]!.processed).toBe(true);
    expect(String(log[0]!.amount_kop)).toBe('150000');
    expect(log[0]!.is_mock).toBe(true);

    const ord = await sql<{ payment_status: string; paid_at: Date | null }[]>`
      SELECT payment_status, paid_at FROM orders WHERE id = ${orderId}
    `;
    expect(ord[0]!.payment_status).toBe('paid');
    expect(ord[0]!.paid_at).not.toBeNull();
  });

  it('РЕПЛЕЙ того же (invoice_id, status) → inserted:false, без двойного эффекта', async () => {
    const res = await recordWebhookEvent({
      log: {
        orderId,
        invoiceId: INVOICE_ID,
        status: 'PAID',
        amountKop: 150000,
        isMock: true,
        rawPayload: { source: 'callback-replay' },
      },
      nextStatus: 'paid',
      comment: 'paykeeper-callback:PAID',
    });
    expect(res.inserted).toBe(false);
    expect(res.processed).toBe(false);

    // По-прежнему ровно одна строка PAID (UNIQUE (invoice_id, status)).
    const cnt = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM paykeeper_payment_log WHERE invoice_id = ${INVOICE_ID} AND status = 'PAID'
    `;
    expect(Number(cnt[0]!.n)).toBe(1);
  });
});
