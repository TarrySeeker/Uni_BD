import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import type { TransactionSql } from 'postgres';

/**
 * ИНТЕГРАЦИЯ (ADR-i18n, инкремент 2b — фикс write-path переводов).
 *
 * РЕГРЕССИЯ: колонка translations пишется через штатный `sql.json(tr.value)`
 * (jsonb-параметр), а НЕ через `${JSON.stringify(tr.value)}::jsonb`. Прежняя
 * реализация биндила JS-строку под ::jsonb → postgres.js слал jsonb-СКАЛЯР-строку
 * (jsonb_typeof='string'), что нарушало CHECK products_translations_obj_chk
 * (jsonb_typeof='object') → PostgresError 23514 → сохранение en/fr-перевода из
 * админки падало 500, перевод НЕ писался. Юнит-моки sql это пропускали; ловится
 * ТОЛЬКО живой БД под реальным CHECK.
 *
 * Гоняет РЕАЛЬНЫЙ `updateProduct` (defineAction + default deps) на живой БД
 * (миграции 0001–0036, у products есть translations jsonb + CHECK). Границы
 * (auth/cache/headers/audit/config) замоканы, `@/lib/db/client` — НАСТОЯЩИЙ.
 * Локально без DATABASE_URL — skipIf пропускает.
 *
 * Инвариант «dev-данные целы»: тест-товар создаётся с уникальным sku и удаляется
 * в afterAll; второй кейс — целиком в откатываемой транзакции (ничего не коммитит).
 */

const hasDb = Boolean(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);

// --- Моки границ (НЕ БД). ------------------------------------------------------
const currentUser: { value: AuthUser | null } = { value: null };
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => currentUser.value,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: async () => true,
}));

describe.skipIf(!hasDb)('write-path переводов — jsonb-оверлей (интеграция)', () => {
  let updateProduct: typeof import('@/lib/catalog/actions').updateProduct;
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  const createdProductIds: string[] = [];

  beforeAll(async () => {
    const actions = await import('@/lib/catalog/actions');
    updateProduct = actions.updateProduct;
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  beforeEach(() => {
    currentUser.value = {
      id: 'i18n-writer-1',
      email: 'owner@shop.io',
      isOwner: true,
      permissions: new Set<PermissionCode>(),
    };
  });

  afterAll(async () => {
    for (const id of createdProductIds) {
      await sql`DELETE FROM products WHERE id = ${id}`;
    }
    await closeSql();
  });

  async function makeProduct(baseName: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${'I18N-' + suffix}, ${'i18n-' + suffix}, ${baseName}, 'active', '100.00')
      RETURNING id
    `;
    createdProductIds.push(p!.id);
    return p!.id;
  }

  it('updateProduct пишет en-перевод как jsonb-ОБЪЕКТ (не строку), база ru не тронута', async () => {
    const baseName = 'Шёлковый платок';
    const productId = await makeProduct(baseName);

    const res = await updateProduct({
      id: productId,
      translations: { en: { name: 'Silk Scarf' } },
    });
    // Прежде здесь была PostgresError 23514 (CHECK) → res.ok === false.
    expect(res.ok).toBe(true);

    const [row] = await sql<
      { typ: string; en_name: string | null; name: string; ru_key: boolean }[]
    >`
      SELECT
        jsonb_typeof(translations)            AS typ,
        translations -> 'en' ->> 'name'        AS en_name,
        name                                   AS name,
        (translations ? 'ru')                  AS ru_key
      FROM products
      WHERE id = ${productId}
    `;

    // (1) translations — jsonb-ОБЪЕКТ (а не скаляр-строка): удовлетворяет CHECK.
    expect(row!.typ).toBe('object');
    // (2) en-перевод дошёл до оверлея.
    expect(row!.en_name).toBe('Silk Scarf');
    // (3) базовая ru-колонка НЕ изменена (пишем только оверлей не-дефолтных языков).
    expect(row!.name).toBe(baseName);
    // (4) дефолтный язык (ru) в оверлей НЕ дублируется.
    expect(row!.ru_key).toBe(false);
  });

  it('нагрузочный CHECK products_translations_obj_chk: sql.json → object проходит внутри откатываемой tx', async () => {
    let capturedType: string | null = null;
    let tempId: string | null = null;

    class Rollback extends Error {}

    await expect(
      sql.begin(async (tx: TransactionSql) => {
        const suffix = Math.random().toString(36).slice(2, 10);
        const [p] = await tx<{ id: string }[]>`
          INSERT INTO products (sku, slug, name, status, base_price)
          VALUES (${'I18N-TX-' + suffix}, ${'i18n-tx-' + suffix}, ${'Платок TX'}, 'active', '100.00')
          RETURNING id
        `;
        tempId = p!.id;

        // ШТАТНЫЙ паттерн репозитория: tx.json(...) сериализует значение как
        // jsonb-параметр (type OID 3802), НЕ как ::jsonb-строку. Под реальным
        // CHECK это НЕ должно бросать 23514.
        const overlay: Record<string, Record<string, unknown>> = {
          en: { name: 'Silk Scarf TX' },
        };
        await tx`
          UPDATE products
          SET translations = ${tx.json(overlay as Record<string, never>)}
          WHERE id = ${tempId}
        `;

        const [r] = await tx<{ typ: string }[]>`
          SELECT jsonb_typeof(translations) AS typ FROM products WHERE id = ${tempId}
        `;
        capturedType = r!.typ;

        // Откат: транзакция ничего не коммитит — dev-данные целы.
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    // UPDATE не бросил 23514, значение легло как jsonb-объект.
    expect(capturedType).toBe('object');

    // Транзакция откатилась — вставленной строки в БД нет.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM products WHERE id = ${tempId}
    `;
    expect(rows.length).toBe(0);
  });
});
