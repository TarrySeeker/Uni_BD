import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mapCategory, mapBrand } from '@/lib/catalog/repository';
import { CategoryUpdateSchema, BrandUpdateSchema } from '@/lib/catalog/schemas';
import { toCategoryTreeDto, toFullBrandDto } from '@/lib/storefront/dto';
import type { Brand, CategoryTreeNode } from '@/lib/catalog/types';
import type { SeoCtx } from '@/lib/seo/meta';

/**
 * §9: картинка категории (categories.image_key) + внешний сайт бренда
 * (brands.external_url). Аддитивно/обратно совместимо.
 *
 * (а) ЮНИТ — мапперы (NULL-совместимость), схемы, DTO (imageUrl/externalUrl).
 * (б) ИНТЕГРАЦИЯ (skipIf без БД) — round-trip записи/чтения колонок на :5434.
 */

const D = new Date('2026-01-01T00:00:00Z');
const SEO: SeoCtx = {
  siteUrl: 'https://shop.test',
  titleTemplate: '%s',
  siteName: 'Shop',
  defaultDescription: null,
  defaultOgImageKey: null,
  publicUrl: (k: string) => `https://cdn.test/${k}`,
  pathPrefix: 'brand',
};

// =============================================================================
// (а) ЮНИТ.
// =============================================================================
describe('§9 catalog — мапперы (юнит)', () => {
  it('mapCategory: image_key → imageKey', () => {
    const c = mapCategory({
      id: 'c1', parent_id: null, slug: 's', name: 'n', description: '', sort: 0,
      is_active: true, image_key: 'categories/x.webp', created_at: D, updated_at: D,
    });
    expect(c.imageKey).toBe('categories/x.webp');
  });

  it('mapCategory: обратная совместимость — image_key отсутствует → null', () => {
    const c = mapCategory({
      id: 'c1', parent_id: null, slug: 's', name: 'n', description: '', sort: 0,
      is_active: true, created_at: D, updated_at: D,
    });
    expect(c.imageKey).toBeNull();
  });

  it('mapBrand: external_url → externalUrl; отсутствие → null', () => {
    const withUrl = mapBrand({
      id: 'b1', slug: 's', name: 'n', description: '', logo_key: null, is_active: true,
      sort: 0, external_url: 'https://brand.example.com', created_at: D, updated_at: D,
    });
    expect(withUrl.externalUrl).toBe('https://brand.example.com');
    const without = mapBrand({
      id: 'b1', slug: 's', name: 'n', description: '', logo_key: null, is_active: true,
      sort: 0, created_at: D, updated_at: D,
    });
    expect(without.externalUrl).toBeNull();
  });
});

describe('§9 catalog — схемы (юнит)', () => {
  const CAT_ID = '11111111-1111-4111-8111-111111111111';
  const BRAND_ID = '22222222-2222-4222-8222-222222222222';

  it('CategoryUpdateSchema принимает imageKey (ключ) и null', () => {
    expect(CategoryUpdateSchema.safeParse({ id: CAT_ID, imageKey: 'categories/x.webp' }).success).toBe(true);
    expect(CategoryUpdateSchema.safeParse({ id: CAT_ID, imageKey: null }).success).toBe(true);
    // Отсутствие поля тоже валидно (обратная совместимость).
    expect(CategoryUpdateSchema.safeParse({ id: CAT_ID }).success).toBe(true);
  });

  it('BrandUpdateSchema: валидный URL проходит, мусор — нет', () => {
    expect(BrandUpdateSchema.safeParse({ id: BRAND_ID, externalUrl: 'https://ok.test' }).success).toBe(true);
    expect(BrandUpdateSchema.safeParse({ id: BRAND_ID, externalUrl: 'not-a-url' }).success).toBe(false);
    expect(BrandUpdateSchema.safeParse({ id: BRAND_ID }).success).toBe(true);
  });
});

describe('§9 catalog — DTO (юнит)', () => {
  function node(imageKey: string | null): CategoryTreeNode {
    return {
      id: 'c1', parentId: null, slug: 'men', name: 'Men', description: '', sort: 0,
      isActive: true, imageKey, seoTitle: null, seoDescription: null, ogTitle: null,
      ogDescription: null, ogImageKey: null, canonicalUrl: null, noindex: false,
      createdAt: D, updatedAt: D, children: [],
    };
  }

  it('toCategoryTreeDto: imageKey → imageUrl через publicUrl; null → null', () => {
    const withUrl = toCategoryTreeDto([node('categories/x.webp')], undefined, (k) => `https://cdn.test/${k}`);
    expect(withUrl[0]!.imageUrl).toBe('https://cdn.test/categories/x.webp');
    const noResolver = toCategoryTreeDto([node('categories/x.webp')]);
    expect(noResolver[0]!.imageUrl).toBeNull();
    const noKey = toCategoryTreeDto([node(null)], undefined, (k) => `https://cdn.test/${k}`);
    expect(noKey[0]!.imageUrl).toBeNull();
  });

  it('toFullBrandDto: externalUrl отдаётся наружу как есть', () => {
    const brand: Brand = {
      id: 'b1', slug: 'bosch', name: 'Bosch', description: 'd', logoKey: null,
      isActive: true, sort: 0, externalUrl: 'https://bosch.test', seoTitle: null,
      seoDescription: null, ogTitle: null, ogDescription: null, ogImageKey: null,
      canonicalUrl: null, noindex: false, createdAt: D, updatedAt: D,
    };
    expect(toFullBrandDto(brand, { seoCtx: SEO }).externalUrl).toBe('https://bosch.test');
    expect(toFullBrandDto({ ...brand, externalUrl: null }, { seoCtx: SEO }).externalUrl).toBeNull();
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('§9 catalog (интеграция, нужна БД)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  let repo: typeof import('@/lib/catalog/repository');
  const tag = 'p1cat-' + Math.random().toString(36).slice(2, 8);
  const catIds: string[] = [];
  const brandIds: string[] = [];

  beforeAll(async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    repo = await import('@/lib/catalog/repository');
  });

  afterAll(async () => {
    for (const id of catIds) await sql`DELETE FROM categories WHERE id = ${id}`;
    for (const id of brandIds) await sql`DELETE FROM brands WHERE id = ${id}`;
    if (closeSql) await closeSql();
  });

  it('categories.image_key round-trip: пишется и читается через listCategories', async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name, image_key)
      VALUES (${`${tag}-c`}, ${'Категория'}, ${'categories/rt.webp'})
      RETURNING id
    `;
    catIds.push(rows[0]!.id);
    const all = await repo.listCategories();
    const found = all.find((c) => c.id === rows[0]!.id);
    expect(found?.imageKey).toBe('categories/rt.webp');
  });

  it('categories: старая запись без image_key читается как null', async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name) VALUES (${`${tag}-c2`}, ${'Без картинки'}) RETURNING id
    `;
    catIds.push(rows[0]!.id);
    const all = await repo.listCategories();
    expect(all.find((c) => c.id === rows[0]!.id)?.imageKey).toBeNull();
  });

  it('brands.external_url round-trip: пишется и читается через getBrandById', async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO brands (slug, name, external_url)
      VALUES (${`${tag}-b`}, ${'Бренд'}, ${'https://brand.rt.test'})
      RETURNING id
    `;
    brandIds.push(rows[0]!.id);
    const b = await repo.getBrandById(rows[0]!.id);
    expect(b?.externalUrl).toBe('https://brand.rt.test');
  });
});
