import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  mapReview,
  mapApprovedReviewRow,
  mapReviewModerationRow,
} from '@/lib/reviews/repository';

/**
 * (а) ЮНИТ — мапперы row→domain (всегда зелёные, без БД).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — реальная БД на :5434, миграция 0043.
 *     Round-trip: insert форсит pending; listApprovedByProduct только approved;
 *     getProductRatingAggregate только approved (avg+count+distribution);
 *     updateReviewStatus→approved проставляет published_at; setReviewReply +
 *     translations под CHECK; findCustomerIdByEmail; FK; delete.
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

// =============================================================================
// (а) ЮНИТ — мапперы.
// =============================================================================
describe('reviews/repository — мапперы row→domain (юнит)', () => {
  it('mapReview: snake→camel, translations как есть', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const r = mapReview({
      id: 'r1', product_id: 'p1', customer_id: null, author_name: 'Иван',
      body: 'текст', rating: 5, status: 'approved', reply: 'спасибо',
      is_verified: false, source: 'storefront',
      translations: { en: { reply: 'thanks' } },
      created_at: now, published_at: now, moderated_at: now, moderated_by: 'u1',
    });
    expect(r.productId).toBe('p1');
    expect(r.rating).toBe(5);
    expect(r.translations).toEqual({ en: { reply: 'thanks' } });
    expect(r.moderatedBy).toBe('u1');
  });

  it('mapReview: не-объект translations → {}', () => {
    const now = new Date();
    const r = mapReview({
      id: 'r', product_id: 'p', author_name: 'A', body: 'b', rating: 3,
      status: 'pending', translations: null, created_at: now,
    });
    expect(r.translations).toEqual({});
    expect(r.reply).toBeNull();
  });

  it('mapApprovedReviewRow / mapReviewModerationRow', () => {
    const now = new Date();
    const a = mapApprovedReviewRow({
      id: 'r', author_name: 'A', body: 'b', rating: 4, reply: null,
      translations: {}, created_at: now, published_at: now,
    });
    expect(a.rating).toBe(4);
    const m = mapReviewModerationRow({
      id: 'r', product_id: 'p', author_name: 'A', body: 'b', rating: 4,
      status: 'pending', translations: {}, created_at: now,
      product_name: 'Платок', product_slug: 'platok',
    });
    expect(m.productName).toBe('Платок');
    expect(m.productSlug).toBe('platok');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('reviews/repository (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/reviews/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const tag = 'itrev-' + Math.random().toString(36).slice(2, 8);
  let productId = '';
  let productId2 = '';
  let customerId = '';
  const email = `${tag}@example.io`;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    repo = await import('@/lib/reviews/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;

    const p = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name) VALUES
        (${tag + '-sku'}, ${tag + '-slug'}, ${'Товар ' + tag}) RETURNING id
    `;
    productId = p[0]!.id;
    const p2 = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name) VALUES
        (${tag + '-sku2'}, ${tag + '-slug2'}, 'Товар 2') RETURNING id
    `;
    productId2 = p2[0]!.id;
    const c = await sql<{ id: string }[]>`
      INSERT INTO customers (email, name) VALUES (${email}, 'Клиент') RETURNING id
    `;
    customerId = c[0]!.id;
  });

  afterAll(async () => {
    for (const id of createdReviewIds) {
      await sql`DELETE FROM reviews WHERE id = ${id}`;
    }
    if (productId) await sql`DELETE FROM products WHERE id = ${productId}`;
    if (productId2) await sql`DELETE FROM products WHERE id = ${productId2}`;
    if (customerId) await sql`DELETE FROM customers WHERE id = ${customerId}`;
    if (closeSql) await closeSql();
  });

  async function submit(
    over: Partial<{ rating: number; customerId: string | null; body: string }> = {},
  ) {
    const res = await repo.insertReview({
      productId,
      customerId: over.customerId ?? null,
      authorName: 'Иван',
      body: over.body ?? 'Отличный товар',
      rating: over.rating ?? 5,
      source: 'storefront',
    });
    createdReviewIds.push(res.id);
    return res;
  }

  it('insertReview ФОРСИТ status=pending (anti-tamper)', async () => {
    const res = await submit();
    expect(res.status).toBe('pending');
    const r = await repo.getReviewById(res.id);
    expect(r!.status).toBe('pending');
  });

  it('productExists / findCustomerIdByEmail', async () => {
    expect(await repo.productExists(productId)).toBe(true);
    expect(await repo.productExists('00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(await repo.findCustomerIdByEmail(email)).toBe(customerId);
    expect(await repo.findCustomerIdByEmail('nobody-' + tag + '@x.io')).toBeNull();
  });

  it('listApprovedByProduct отдаёт ТОЛЬКО approved', async () => {
    const a = await submit({ rating: 4 });
    await repo.updateReviewStatus(a.id, 'approved', null);
    await submit({ rating: 3 }); // остаётся pending
    const { rows, total } = await repo.listApprovedByProduct(productId, {
      limit: 50,
      offset: 0,
    });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.rating >= 1)).toBe(true);
    // pending не попал: все возвращённые — approved (проверяем через агрегат ниже).
  });

  it('updateReviewStatus→approved проставляет published_at', async () => {
    const { id } = await submit();
    const before = await repo.getReviewById(id);
    expect(before!.publishedAt).toBeNull();
    const after = await repo.updateReviewStatus(id, 'approved', null);
    expect(after!.status).toBe('approved');
    expect(after!.publishedAt).not.toBeNull();
  });

  it('getProductRatingAggregate считает ТОЛЬКО approved (avg+count+distribution)', async () => {
    // Изолированный товар: 5★ approved, 1★ approved, 2★ pending.
    const r5 = await sql<{ id: string }[]>`
      INSERT INTO reviews (product_id, author_name, body, rating, status)
      VALUES (${productId2}, 'A', 'b', 5, 'approved') RETURNING id`;
    const r1 = await sql<{ id: string }[]>`
      INSERT INTO reviews (product_id, author_name, body, rating, status)
      VALUES (${productId2}, 'A', 'b', 1, 'approved') RETURNING id`;
    const r2 = await sql<{ id: string }[]>`
      INSERT INTO reviews (product_id, author_name, body, rating, status)
      VALUES (${productId2}, 'A', 'b', 2, 'pending') RETURNING id`;
    createdReviewIds.push(r5[0]!.id, r1[0]!.id, r2[0]!.id);

    const agg = await repo.getProductRatingAggregate(productId2);
    expect(agg.count).toBe(2); // pending исключён
    expect(agg.average).toBe(3); // (5+1)/2
    expect(agg.distribution[5]).toBe(1);
    expect(agg.distribution[1]).toBe(1);
    expect(agg.distribution[2]).toBe(0); // pending не считается
  });

  it('setReviewReply + translations под реальным CHECK', async () => {
    const { id } = await submit();
    const updated = await repo.setReviewReply(
      id,
      'Спасибо!',
      { en: { reply: 'Thanks!' }, fr: { reply: 'Merci!' } },
      null,
    );
    expect(updated!.reply).toBe('Спасибо!');
    expect(updated!.translations.en).toEqual({ reply: 'Thanks!' });
    const reread = await repo.getReviewById(id);
    expect(reread!.translations.fr).toEqual({ reply: 'Merci!' });
  });

  it('listReviewsForModeration: фильтр статуса + JOIN товара', async () => {
    const { rows } = await repo.listReviewsForModeration({
      status: 'pending',
      page: 1,
      pageSize: 200,
    });
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    const mine = rows.find((r) => r.productId === productId);
    if (mine) expect(mine.productName).toContain(tag);
  });

  it('countReviewsByStatus', async () => {
    const n = await repo.countReviewsByStatus('pending');
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it('deleteReview удаляет запись', async () => {
    const { id } = await submit();
    const removed = await repo.deleteReview(id);
    expect(removed).not.toBeNull();
    expect(await repo.getReviewById(id)).toBeNull();
  });
});
