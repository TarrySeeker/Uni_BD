import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';

import { mapGiftCertificate, mapRedemption } from '@/lib/gift-certificates/repository';

/**
 * (а) ЮНИТ — мапперы row→domain (всегда зелёные, без БД).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — реальная БД на :5434, миграции
 *     0039–0041. Проверяет КЛЮЧЕВУЮ механику: остаток = номинал − потрачено;
 *     ЧАСТИЧНОЕ списание по НЕСКОЛЬКИМ заказам (Σ ledger = spent_total); запрет
 *     оверспенда; идемпотентность повторного списания заказа; возврат (release)
 *     восстанавливает баланс; i18n description/terms персистятся под реальным
 *     CHECK jsonb_typeof='object'.
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll (DELETE orders
 * каскадит redemptions; DELETE gift_certificates убирает сертификаты).
 */

// =============================================================================
// (а) ЮНИТ — мапперы.
// =============================================================================
describe('gift-certificates/repository — мапперы row→domain (юнит)', () => {
  it('mapGiftCertificate: snake→camel, remaining вычисляется', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const c = mapGiftCertificate({
      id: 'g1',
      code: 'GIFT500',
      name: 'Метка',
      description: 'Описание',
      terms: 'Условия',
      initial_amount: '500.00',
      spent_total: '150.00',
      currency: 'RUB',
      status: 'active',
      valid_until: null,
      translations: { en: { description: 'Gift' } },
      comment: '',
      created_at: now,
      updated_at: now,
    });
    expect(c.remaining).toBe('350.00');
    expect(c.description).toBe('Описание');
    expect(c.translations).toEqual({ en: { description: 'Gift' } });
    expect(c.validUntil).toBeNull();
  });

  it('mapRedemption: reversed_at null/Date', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const r = mapRedemption({
      id: 'r1',
      certificate_id: 'g1',
      order_id: 'o1',
      amount: '120.00',
      reversed_at: null,
      created_at: now,
    });
    expect(r.amount).toBe('120.00');
    expect(r.reversedAt).toBeNull();
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('gift-certificates/repository (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/gift-certificates/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const createdOrderIds: string[] = [];
  const createdCertIds: string[] = [];

  /** Создаёт минимальный заказ (только NOT NULL без дефолта) и возвращает id. */
  async function makeOrder(): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 12);
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone)
      VALUES (${'GT-' + suffix}, '0.00', '0.00', 'Gift Test', ${'gifttest+' + suffix + '@example.com'}, '+70000000000')
      RETURNING id
    `;
    createdOrderIds.push(o!.id);
    return o!.id;
  }

  /** Создаёт сертификат с номиналом и возвращает id. */
  async function makeCert(initial: string, over: Partial<{ code: string; validUntil: string | null; status: string; description: string; terms: string; translations: object }> = {}): Promise<string> {
    const code = over.code ?? 'GIFT-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO gift_certificates (code, initial_amount, valid_until, status, description, terms, translations)
      VALUES (
        ${code}, ${initial}, ${over.validUntil ?? null}, ${over.status ?? 'active'},
        ${over.description ?? null}, ${over.terms ?? null}, ${sql.json((over.translations ?? {}) as Record<string, never>)}
      )
      RETURNING id
    `;
    createdCertIds.push(c!.id);
    return c!.id;
  }

  /** Сумма активных списаний сертификата (Σ ledger WHERE reversed_at IS NULL). */
  async function ledgerSum(certId: string): Promise<string> {
    const [row] = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM gift_certificate_redemptions
      WHERE certificate_id = ${certId} AND reversed_at IS NULL
    `;
    return Number(row!.total).toFixed(2);
  }

  beforeAll(async () => {
    repo = await import('@/lib/gift-certificates/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await sql`DELETE FROM orders WHERE id = ${id}`; // каскадит redemptions
    }
    for (const id of createdCertIds) {
      await sql`DELETE FROM gift_certificates WHERE id = ${id}`;
    }
    if (closeSql) await closeSql();
  });

  it('остаток = номинал − потрачено (getBalance)', async () => {
    const certId = await makeCert('500.00');
    expect(await repo.getBalance(certId)).toBe('500.00');
  });

  it('ЧАСТИЧНОЕ списание по 2+ заказам: Σ ledger = spent_total; исчерпание → depleted', async () => {
    const certId = await makeCert('500.00');
    const orderA = await makeOrder();
    const orderB = await makeOrder();
    const orderC = await makeOrder();

    // Заказ A: списываем 300 → остаток 200.
    const a = await repo.redeemGift({ certificateId: certId, orderId: orderA, amount: '300.00' });
    expect(a.applied).toBe(true);
    expect(a.remaining).toBe('200.00');

    // Заказ B: списываем оставшиеся 200 → остаток 0, статус depleted.
    const b = await repo.redeemGift({ certificateId: certId, orderId: orderB, amount: '200.00' });
    expect(b.applied).toBe(true);
    expect(b.remaining).toBe('0.00');

    const cert = await repo.getGiftCertificateById(certId);
    expect(cert!.spentTotal).toBe('500.00');
    expect(cert!.status).toBe('depleted');

    // Инвариант: Σ активного леджера == spent_total.
    expect(await ledgerSum(certId)).toBe('500.00');

    // Заказ C: списывать больше нечего (depleted) → ошибка, баланс не тронут.
    await expect(
      repo.redeemGift({ certificateId: certId, orderId: orderC, amount: '10.00' }),
    ).rejects.toThrow();
    expect((await repo.getGiftCertificateById(certId))!.spentTotal).toBe('500.00');
  });

  it('частичное: остаток 200, «корзина» 120 → списано 120, остаток 80', async () => {
    const certId = await makeCert('200.00');
    const order = await makeOrder();
    const r = await repo.redeemGift({ certificateId: certId, orderId: order, amount: '120.00' });
    expect(r.applied).toBe(true);
    expect(r.remaining).toBe('80.00');
    expect(await repo.getBalance(certId)).toBe('80.00');
    expect(await ledgerSum(certId)).toBe('120.00');
  });

  it('нельзя списать больше остатка (оверспенд) → throw, spent не меняется', async () => {
    const certId = await makeCert('100.00');
    const order = await makeOrder();
    await expect(
      repo.redeemGift({ certificateId: certId, orderId: order, amount: '150.00' }),
    ).rejects.toThrow();
    expect((await repo.getGiftCertificateById(certId))!.spentTotal).toBe('0.00');
    expect(await ledgerSum(certId)).toBe('0.00');
  });

  it('идемпотентность: повторное списание того же заказа НЕ декрементит дважды', async () => {
    const certId = await makeCert('500.00');
    const order = await makeOrder();
    const first = await repo.redeemGift({ certificateId: certId, orderId: order, amount: '100.00' });
    expect(first.applied).toBe(true);
    const second = await repo.redeemGift({ certificateId: certId, orderId: order, amount: '100.00' });
    expect(second.applied).toBe(false);
    expect(second.alreadyRedeemed).toBe(true);
    expect((await repo.getGiftCertificateById(certId))!.spentTotal).toBe('100.00');
    expect(await ledgerSum(certId)).toBe('100.00');
  });

  it('атомарность гонки: 2 параллельных списания сверх остатка → одно применяется, баланс не в минус', async () => {
    const certId = await makeCert('100.00');
    const orderA = await makeOrder();
    const orderB = await makeOrder();
    // Каждый заказ пытается списать 80 (в сумме 160 > 100). FOR UPDATE сериализует:
    // одно проходит (80), второе не влезает в остаток 20 → оверспенд/rollback.
    const results = await Promise.allSettled([
      repo.redeemGift({ certificateId: certId, orderId: orderA, amount: '80.00' }),
      repo.redeemGift({ certificateId: certId, orderId: orderB, amount: '80.00' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    const cert = await repo.getGiftCertificateById(certId);
    expect(cert!.spentTotal).toBe('80.00'); // не 160, не в минус
    expect(await ledgerSum(certId)).toBe('80.00');
  });

  it('возврат (release) восстанавливает баланс и снимает depleted; идемпотентен', async () => {
    const certId = await makeCert('300.00');
    const order = await makeOrder();
    await repo.redeemGift({ certificateId: certId, orderId: order, amount: '300.00' });
    expect((await repo.getGiftCertificateById(certId))!.status).toBe('depleted');

    const rel = await repo.releaseGift({ orderId: order });
    expect(rel.reversedCount).toBe(1);
    expect(rel.reversedAmount).toBe('300.00');
    const cert = await repo.getGiftCertificateById(certId);
    expect(cert!.spentTotal).toBe('0.00');
    expect(cert!.status).toBe('active');
    expect(await ledgerSum(certId)).toBe('0.00');

    // Повторный возврат — no-op (идемпотентность по reversed_at).
    const again = await repo.releaseGift({ orderId: order });
    expect(again.reversedCount).toBe(0);
    expect((await repo.getGiftCertificateById(certId))!.spentTotal).toBe('0.00');
  });

  it('истёкший срок → списание отвергается', async () => {
    const certId = await makeCert('100.00', { validUntil: '2020-01-01T00:00:00Z' });
    const order = await makeOrder();
    await expect(
      repo.redeemGift({ certificateId: certId, orderId: order, amount: '10.00' }),
    ).rejects.toThrow(/срок/i);
  });

  it('disabled → списание отвергается', async () => {
    const certId = await makeCert('100.00', { status: 'disabled' });
    const order = await makeOrder();
    await expect(
      repo.redeemGift({ certificateId: certId, orderId: order, amount: '10.00' }),
    ).rejects.toThrow();
  });

  it('findByCode находит по коду (citext, регистронезависимо)', async () => {
    const code = 'MiXeD-' + Math.random().toString(36).slice(2, 8);
    const certId = await makeCert('250.00', { code });
    const found = await repo.findByCode(code.toUpperCase());
    expect(found).not.toBeNull();
    expect(found!.id).toBe(certId);
  });

  it('i18n: description/terms + translations(en/fr) персистятся под реальным CHECK jsonb_typeof=object', async () => {
    const certId = await makeCert('400.00', {
      description: 'Подарочный сертификат',
      terms: 'Действует 1 год',
      translations: { en: { description: 'Gift certificate', terms: 'Valid 1 year' }, fr: { description: 'Chèque cadeau' } },
    });
    const cert = await repo.getGiftCertificateById(certId);
    expect(cert!.description).toBe('Подарочный сертификат');
    expect(cert!.terms).toBe('Действует 1 год');
    expect(cert!.translations).toEqual({
      en: { description: 'Gift certificate', terms: 'Valid 1 year' },
      fr: { description: 'Chèque cadeau' },
    });
    // Убедимся, что в БД лежит именно jsonb-ОБЪЕКТ (CHECK прошёл).
    const [row] = await sql<{ t: string }[]>`
      SELECT jsonb_typeof(translations) AS t FROM gift_certificates WHERE id = ${certId}
    `;
    expect(row!.t).toBe('object');
  });

  it('insertGiftCertificate (repo) + getRedemptions отдают историю', async () => {
    const cert = await repo.insertGiftCertificate({
      code: 'REPO-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      name: 'Repo issue',
      initialAmount: '150.00',
      validUntil: null,
      description: null,
      terms: null,
      comment: '',
      translations: {},
    });
    createdCertIds.push(cert.id);
    const order = await makeOrder();
    await repo.redeemGift({ certificateId: cert.id, orderId: order, amount: '50.00' });
    const history = await repo.getRedemptions(cert.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.amount).toBe('50.00');
  });
});
