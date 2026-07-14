import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mapProductBlock, mapBlockAuthorRef, asTabs } from '@/lib/product-blocks/repository';

/**
 * (а) ЮНИТ — чистые мапперы row→domain (всегда зелёные, без БД).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — реальная БД на :5434, миграция 0048.
 *     Round-trip: upsert (insert/update), listByProduct порядок + JOIN автора,
 *     reorder, delete; FK product CASCADE; author designers SET NULL.
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

// =============================================================================
// (а) ЮНИТ — мапперы.
// =============================================================================
describe('product-blocks/repository — мапперы (юнит)', () => {
  it('asTabs: массив/строка-JSON/мусор → нормализованный ProductBlockTab[]', () => {
    expect(asTabs([{ name: 'A', text: 'b' }, { name: 'C' }])).toEqual([
      { name: 'A', text: 'b' },
      { name: 'C', text: '' },
    ]);
    expect(asTabs('[{"name":"X","text":"y"}]')).toEqual([{ name: 'X', text: 'y' }]);
    expect(asTabs(null)).toEqual([]);
    expect(asTabs('not json')).toEqual([]);
    expect(asTabs({ nope: 1 })).toEqual([]);
  });

  it('mapBlockAuthorRef: JOIN-колонки d_* → DesignerRef; без d_id → null', () => {
    expect(
      mapBlockAuthorRef({ d_id: 'd1', d_slug: 'ivanov', d_name: 'Иванов', d_image_key: 'k' }),
    ).toEqual({ id: 'd1', slug: 'ivanov', name: 'Иванов', imageKey: 'k' });
    expect(mapBlockAuthorRef({ d_id: null })).toBeNull();
  });

  it('mapProductBlock: snake→camel, tabs/translations как есть, автор из JOIN', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const b = mapProductBlock({
      id: 'bl1', product_id: 'p1', type: 'quote', title: 'T', blockquot: 'Q',
      author_designer_id: 'd1', body: null, image_key: 'k', tabs: [{ name: 'n', text: 't' }],
      sort: 3, translations: { en: { title: 'Ti' } }, created_at: now,
      d_id: 'd1', d_slug: 'ivanov', d_name: 'Иванов', d_image_key: null,
    });
    expect(b.type).toBe('quote');
    expect(b.blockquot).toBe('Q');
    expect(b.authorDesignerId).toBe('d1');
    expect(b.author).toEqual({ id: 'd1', slug: 'ivanov', name: 'Иванов', imageKey: null });
    expect(b.tabs).toEqual([{ name: 'n', text: 't' }]);
    expect(b.translations).toEqual({ en: { title: 'Ti' } });
    expect(b.sort).toBe(3);
  });

  it('mapProductBlock: не-объект translations → {}, отсутствие автора → null', () => {
    const b = mapProductBlock({
      id: 'b', product_id: 'p', type: 'text', tabs: null, translations: null,
      created_at: new Date(), d_id: null,
    });
    expect(b.translations).toEqual({});
    expect(b.tabs).toEqual([]);
    expect(b.author).toBeNull();
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('product-blocks/repository (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/product-blocks/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const tag = 'itpb-' + Math.random().toString(36).slice(2, 8);
  let productId = '';
  let productCascadeId = '';
  let designerId = '';

  beforeAll(async () => {
    repo = await import('@/lib/product-blocks/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;

    const p = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name) VALUES
        (${tag + '-sku'}, ${tag + '-slug'}, ${'Товар ' + tag}) RETURNING id`;
    productId = p[0]!.id;
    const pc = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name) VALUES
        (${tag + '-skuc'}, ${tag + '-slugc'}, 'Товар CASCADE') RETURNING id`;
    productCascadeId = pc[0]!.id;
    const d = await sql<{ id: string }[]>`
      INSERT INTO designers (slug, name) VALUES (${tag + '-d'}, ${'Автор ' + tag}) RETURNING id`;
    designerId = d[0]!.id;
  });

  afterAll(async () => {
    if (productId) await sql`DELETE FROM products WHERE id = ${productId}`;
    if (productCascadeId) await sql`DELETE FROM products WHERE id = ${productCascadeId}`;
    if (designerId) await sql`DELETE FROM designers WHERE id = ${designerId}`;
    if (closeSql) await closeSql();
  });

  function writeData(over: Partial<import('@/lib/product-blocks/repository').BlockWriteData> = {}) {
    return {
      productId,
      type: 'text' as const,
      title: null,
      blockquot: null,
      authorDesignerId: null,
      body: null,
      imageKey: null,
      tabs: [],
      sort: null,
      translations: {},
      ...over,
    };
  }

  it('upsert INSERT назначает sort в хвост и listByProduct читает в порядке', async () => {
    const a = await repo.upsertBlock(writeData({ type: 'text', body: 'Первый' }));
    const b = await repo.upsertBlock(writeData({ type: 'text', body: 'Второй' }));
    const list = await repo.listBlocksByProduct(productId);
    const ids = list.map((x) => x.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(list.find((x) => x.id === a.id)!.body).toBe('Первый');
  });

  it('quote-блок c author резолвит кросс-линк через JOIN designers', async () => {
    const q = await repo.upsertBlock(
      writeData({ type: 'quote', blockquot: 'Цитата', authorDesignerId: designerId }),
    );
    const got = await repo.getBlockById(q.id);
    expect(got!.type).toBe('quote');
    expect(got!.authorDesignerId).toBe(designerId);
    expect(got!.author).not.toBeNull();
    expect(got!.author!.name).toContain(tag);
  });

  it('upsert UPDATE меняет поля и структурные табы + translations под CHECK', async () => {
    const created = await repo.upsertBlock(writeData({ type: 'tabs' }));
    const updated = await repo.upsertBlock(
      writeData({
        id: created.id,
        type: 'tabs',
        title: 'Табы',
        tabs: [{ name: 'Уход', text: 'Стирка' }],
        translations: { en: { title: 'Tabs', tabs: [{ name: 'Care', text: 'Wash' }] } },
      }),
    );
    expect(updated.id).toBe(created.id);
    const got = await repo.getBlockById(created.id);
    expect(got!.title).toBe('Табы');
    expect(got!.tabs).toEqual([{ name: 'Уход', text: 'Стирка' }]);
    expect(got!.translations.en).toEqual({ title: 'Tabs', tabs: [{ name: 'Care', text: 'Wash' }] });
  });

  it('reorderBlocks переставляет sort в заданном порядке', async () => {
    const before = await repo.listBlocksByProduct(productId);
    const order = before.map((x) => x.id).reverse();
    await repo.reorderBlocks(productId, order);
    const after = await repo.listBlocksByProduct(productId);
    expect(after.map((x) => x.id)).toEqual(order);
  });

  it('удаление дизайнера → author_designer_id SET NULL, блок жив', async () => {
    const d2 = await sql<{ id: string }[]>`
      INSERT INTO designers (slug, name) VALUES (${tag + '-d2'}, 'Временный автор') RETURNING id`;
    const q = await repo.upsertBlock(
      writeData({ type: 'quote', blockquot: 'C', authorDesignerId: d2[0]!.id }),
    );
    await sql`DELETE FROM designers WHERE id = ${d2[0]!.id}`;
    const got = await repo.getBlockById(q.id);
    expect(got).not.toBeNull(); // блок пережил удаление автора
    expect(got!.authorDesignerId).toBeNull();
    expect(got!.author).toBeNull();
  });

  it('deleteBlock удаляет секцию', async () => {
    const b = await repo.upsertBlock(writeData({ type: 'text', body: 'del' }));
    const removed = await repo.deleteBlock(b.id);
    expect(removed).not.toBeNull();
    expect(await repo.getBlockById(b.id)).toBeNull();
  });

  it('удаление товара → CASCADE удаляет его секции', async () => {
    const deletedId = productCascadeId;
    await repo.upsertBlock(writeData({ productId: deletedId, type: 'text', body: 'x' }));
    expect((await repo.listBlocksByProduct(deletedId)).length).toBeGreaterThan(0);
    await sql`DELETE FROM products WHERE id = ${deletedId}`;
    productCascadeId = ''; // уже удалён — afterAll не трогает
    const remaining = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM product_blocks WHERE product_id = ${deletedId}`;
    expect(remaining[0]!.n).toBe(0);
  });
});
