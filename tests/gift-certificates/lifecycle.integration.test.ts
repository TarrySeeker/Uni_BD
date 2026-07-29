import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — реальный SQL двух починок аудита:
 *
 *  • находка №10 — пополнение исчерпанного сертификата возвращает его в работу.
 *    Правило считается чистой функцией, но ПРИМЕНЯЕТСЯ в SQL (updateGiftFieldsDb),
 *    и именно там легко ошибиться в единицах и типах: номинал приходит строкой
 *    NUMERIC-параметром и сравнивается с колонкой spent_total. Юнит с моком
 *    репозитория этого не проверил бы вообще.
 *
 *  • минор №3 — markExpiredGiftCertificates помечает истёкшие и НЕ трогает
 *    отключённые / уже истёкшие (идемпотентность крона).
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('жизненный цикл сертификата (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/gift-certificates/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  let updateGiftFields: (input: never) => Promise<{ status: string; initialAmount: string }>;

  const createdCertIds: string[] = [];

  async function makeCert(
    initial: string,
    over: Partial<{ spent: string; status: string; validUntil: string | null }> = {},
  ): Promise<string> {
    const code = 'LC-' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO gift_certificates (code, initial_amount, spent_total, status, valid_until, translations)
      VALUES (
        ${code}, ${initial}, ${over.spent ?? '0.00'}, ${over.status ?? 'active'},
        ${over.validUntil ?? null}, ${sql.json({} as Record<string, never>)}
      )
      RETURNING id
    `;
    createdCertIds.push(c!.id);
    return c!.id;
  }

  async function statusOf(id: string): Promise<string> {
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM gift_certificates WHERE id = ${id}
    `;
    return row!.status;
  }

  /** Полный набор provided-флагов: правим только номинал и, может быть, статус. */
  function topUp(id: string, initialAmount: string, reviveStatus: string | null) {
    return {
      id,
      initialAmount,
      reviveStatus,
      validUntilProvided: false,
      descriptionProvided: false,
      termsProvided: false,
      translationsProvided: false,
      purchaserProvided: false,
      recipientProvided: false,
    };
  }

  beforeAll(async () => {
    repo = await import('@/lib/gift-certificates/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    const actions = await import('@/lib/gift-certificates/actions');
    updateGiftFields = actions.productionGiftDeps().updateGiftFields as never;
  });

  afterAll(async () => {
    for (const id of createdCertIds) {
      await sql`DELETE FROM gift_certificates WHERE id = ${id}`;
    }
    if (closeSql) await closeSql();
  });

  // -------------------------------------------------------------------------
  // Находка №10.
  // -------------------------------------------------------------------------

  it('🔴 №10: пополнение исчерпанного возвращает его в active И даёт остаток', async () => {
    const id = await makeCert('500.00', { spent: '500.00', status: 'depleted' });
    expect(await statusOf(id)).toBe('depleted');

    const after = await updateGiftFields(topUp(id, '1500.00', 'active') as never);
    expect(after.status).toBe('active');
    expect(after.initialAmount).toBe('1500.00');
    expect(await repo.getBalance(id)).toBe('1000.00');
    expect(await statusOf(id)).toBe('active');
  });

  it('🔴 №10: оживший код снова принимается сервисом (assertRedeemable не отбивает)', async () => {
    const id = await makeCert('500.00', { spent: '500.00', status: 'depleted' });
    await updateGiftFields(topUp(id, '800.00', 'active') as never);

    const { assertRedeemable } = await import('@/lib/gift-certificates/service');
    const cert = await repo.getGiftCertificateById(id);
    expect(cert).not.toBeNull();
    // Это и был симптом дефекта: остаток есть, а код мёртв.
    expect(assertRedeemable(cert!)).toBe('300.00');
  });

  it('🔴 №10: SQL-guard не оживляет ОТКЛЮЧЁННЫЙ код, даже если reviveStatus пришёл', async () => {
    const id = await makeCert('500.00', { spent: '500.00', status: 'disabled' });
    // Имитируем гонку: между чтением строки и UPDATE код отключили.
    const after = await updateGiftFields(topUp(id, '1500.00', 'active') as never);
    expect(after.status).toBe('disabled');
    expect(await statusOf(id)).toBe('disabled');
  });

  it('🔴 №10: пополнение, не покрывающее потраченное, статус не меняет', async () => {
    const id = await makeCert('500.00', { spent: '500.00', status: 'depleted' });
    const after = await updateGiftFields(topUp(id, '500.00', 'active') as never);
    expect(after.status).toBe('depleted');
  });

  it('№10: обычная правка (reviveStatus=null) статус не трогает', async () => {
    const id = await makeCert('500.00', { spent: '500.00', status: 'depleted' });
    const after = await updateGiftFields({
      ...topUp(id, '900.00', null),
      name: 'метка',
    } as never);
    expect(after.status).toBe('depleted');
  });

  // -------------------------------------------------------------------------
  // Минор №3.
  // -------------------------------------------------------------------------

  it('🔴 №3: markExpiredGiftCertificates помечает истёкший active', async () => {
    const id = await makeCert('500.00', { validUntil: '2020-01-01T00:00:00Z' });
    expect(await statusOf(id)).toBe('active');
    const marked = await repo.markExpiredGiftCertificates();
    expect(marked).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe('expired');
  });

  it('№3: истёкший depleted тоже помечается (остаток мог вернуться рефандом)', async () => {
    const id = await makeCert('500.00', {
      spent: '500.00',
      status: 'depleted',
      validUntil: '2020-01-01T00:00:00Z',
    });
    await repo.markExpiredGiftCertificates();
    expect(await statusOf(id)).toBe('expired');
  });

  it('🔴 №3: ОТКЛЮЧЁННЫЙ не превращается в expired (истечение не снимает блокировку)', async () => {
    const id = await makeCert('500.00', {
      status: 'disabled',
      validUntil: '2020-01-01T00:00:00Z',
    });
    await repo.markExpiredGiftCertificates();
    expect(await statusOf(id)).toBe('disabled');
  });

  it('№3: код со сроком в БУДУЩЕМ не трогается', async () => {
    const id = await makeCert('500.00', { validUntil: '2099-01-01T00:00:00Z' });
    await repo.markExpiredGiftCertificates();
    expect(await statusOf(id)).toBe('active');
  });

  it('№3: бессрочный (valid_until IS NULL) не трогается', async () => {
    const id = await makeCert('500.00', { validUntil: null });
    await repo.markExpiredGiftCertificates();
    expect(await statusOf(id)).toBe('active');
  });

  it('🔴 №3: повторный прогон идемпотентен (уже expired не пересчитывается)', async () => {
    const id = await makeCert('500.00', { validUntil: '2020-01-01T00:00:00Z' });
    await repo.markExpiredGiftCertificates();
    expect(await statusOf(id)).toBe('expired');
    // Второй прогон этот код уже не видит: считаем, что среди помеченных его нет.
    const before = await statusOf(id);
    await repo.markExpiredGiftCertificates();
    expect(await statusOf(id)).toBe(before);
  });
});
