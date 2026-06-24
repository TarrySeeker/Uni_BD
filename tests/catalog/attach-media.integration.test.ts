import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ИНТЕГРАЦИЯ (волна 14): attachMedia авто-назначает первое загруженное фото
 * главным (is_primary=true), если у товара ещё НЕТ главного. Иначе каталог
 * витрины (берёт ТОЛЬКО is_primary → primary_media_url) показывал бы товар без
 * обложки, хотя фото загружено и видно в карточке.
 *
 * Гоняет РЕАЛЬНУЮ транзакцию attachMedia (sql.begin с авто-главным) на живой БД
 * с миграциями 0005–0011. Локально без DATABASE_URL — skipIf пропускает. Сеть/
 * Next/S3/sharp не нужны: границы (auth/cache/headers/audit/storage/image)
 * замоканы, но `@/lib/db/client` — НАСТОЯЩИЙ (проверяем фикс именно в SQL).
 */

const hasDb = Boolean(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);

// --- Моки границ (НЕ БД). storage/image — чтобы не звать S3/sharp. ------------
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
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    put: async (key: string) => ({ key, url: `https://cdn.test/${key}`, size: 1234 }),
    delete: async () => {},
  }),
}));
vi.mock('@/lib/storage/validate', () => ({
  validateUpload: async () => ({ ok: true, mime: 'image/webp' }),
}));
vi.mock('@/lib/storage/image', () => ({
  generatePreviews: async () => ({ main: { buffer: Buffer.from('webp'), width: 800, height: 600 } }),
}));

describe.skipIf(!hasDb)('attachMedia — авто-главное фото (интеграция)', () => {
  let attachMedia: typeof import('@/lib/catalog/actions').attachMedia;
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  const createdProductIds: string[] = [];

  beforeAll(async () => {
    const actions = await import('@/lib/catalog/actions');
    attachMedia = actions.attachMedia;
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  beforeEach(() => {
    currentUser.value = {
      id: 'u-1',
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

  async function makeProduct(): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${'AM-' + suffix}, ${'am-' + suffix}, ${'AttachMedia ' + suffix}, 'active', '100.00')
      RETURNING id
    `;
    createdProductIds.push(p!.id);
    return p!.id;
  }

  async function isPrimary(mediaId: string): Promise<boolean> {
    const [row] = await sql<{ is_primary: boolean }[]>`
      SELECT is_primary FROM product_media WHERE id = ${mediaId}
    `;
    return Boolean(row?.is_primary);
  }

  it('первое фото без isPrimary → авто-назначается главным', async () => {
    const productId = await makeProduct();
    const res = await attachMedia({ productId, filename: 'a.jpg', bytes: Buffer.from('x') });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await isPrimary(res.data.id)).toBe(true);
  });

  it('второе фото без isPrimary → НЕ главное (главное уже есть)', async () => {
    const productId = await makeProduct();
    const first = await attachMedia({ productId, filename: 'a.jpg', bytes: Buffer.from('x') });
    const second = await attachMedia({ productId, filename: 'b.jpg', bytes: Buffer.from('y') });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(await isPrimary(first.data.id)).toBe(true);
    expect(await isPrimary(second.data.id)).toBe(false);
  });

  it('явный isPrimary=true на втором фото → перебивает прежнее главное', async () => {
    const productId = await makeProduct();
    const first = await attachMedia({ productId, filename: 'a.jpg', bytes: Buffer.from('x') });
    const second = await attachMedia({
      productId,
      filename: 'b.jpg',
      bytes: Buffer.from('y'),
      isPrimary: true,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(await isPrimary(first.data.id)).toBe(false); // прежнее снято
    expect(await isPrimary(second.data.id)).toBe(true);
    // Частичный индекс product_media_primary_uniq допускает РОВНО одно главное.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM product_media
      WHERE product_id = ${productId} AND is_primary
    `;
    expect(n).toBe(1);
  });
});
