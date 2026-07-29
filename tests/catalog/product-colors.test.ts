import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mapProduct } from '@/lib/catalog/repository';
import { toProductDetailDto } from '@/lib/storefront/dto';
import type { ProductColor, ProductDetail } from '@/lib/catalog/types';
import type { SeoCtx } from '@/lib/seo/meta';
// ETL-загрузчик (.mjs): проверяем ЧИСТЫЕ функции нормализации/разбора источника.
// Импорт не запускает main() — он под guard invokedDirectly.
import { normalizeColors, parseSource } from '../../scripts/load-product-colors.mjs';

/**
 * products.colors (миграция 0050) — дисплейные цвето-свотчи товара (легаси-блок
 * carre `.wv__colors`). НЕ покупаемые варианты. Аддитивно/обратно совместимо.
 *
 * (а) ЮНИТ — mapProduct (парсинг jsonb→ProductColor[], NULL/мусор→[]) + DTO
 *     (toProductDetailDto прокидывает colors как [{hex,name}], пустой → []).
 * (б) ИНТЕГРАЦИЯ (skipIf без БД) — round-trip записи/чтения колонки на :5434.
 */

const D = new Date('2026-01-01T00:00:00Z');

const SEO: SeoCtx = {
  siteUrl: 'https://shop.test',
  titleTemplate: '%s',
  siteName: 'Shop',
  defaultDescription: null,
  defaultOgImageKey: null,
  publicUrl: (k: string) => `https://cdn.test/${k}`,
  pathPrefix: 'product',
};

/** Минимальная строка products для mapProduct (только релевантные + обязательные). */
function productRow(colors: unknown): Record<string, unknown> {
  return {
    id: 'p1', sku: 'SKU1', slug: 'coat', name: 'Coat', description: '',
    status: 'active', base_price: '1000.00', compare_at_price: null,
    is_featured: false, is_new: null, brand_id: null, designer_id: null,
    attributes_cache: {}, colors, seo_title: null, seo_description: null,
    created_at: D, updated_at: D,
  };
}

/** Доменный ProductDetail для DTO-теста (свотчи инъектируются). */
function productDetail(colors: ProductColor[]): ProductDetail {
  return {
    id: 'p1', sku: 'SKU1', slug: 'coat', name: 'Coat', description: '',
    status: 'active', basePrice: '1000.00', displayPrices: {}, compareAtPrice: null,
    isFeatured: false, isNew: null, brandId: null, designerId: null,
    attributesCache: {}, colors,
    seoTitle: null, seoDescription: null, ogTitle: null, ogDescription: null,
    ogImageKey: null, canonicalUrl: null, noindex: false,
    weightG: null, lengthCm: null, widthCm: null, heightCm: null,
    createdAt: D, updatedAt: D,
    categories: [], variants: [], attributes: [], media: [], inventory: [],
    brand: null, designer: null,
  };
}

// =============================================================================
// (а) ЮНИТ — mapProduct.
// =============================================================================
describe('catalog — mapProduct.colors (юнит)', () => {
  it('jsonb-массив объектов → ProductColor[] (порядок сохранён)', () => {
    const p = mapProduct(
      productRow([
        { hex: '#ff0000', name: 'Красный' },
        { hex: '#0000ff', name: 'Синий' },
      ]),
    );
    expect(p.colors).toEqual([
      { hex: '#ff0000', name: 'Красный' },
      { hex: '#0000ff', name: 'Синий' },
    ]);
  });

  it('JSON-строка (как отдаёт psql) парсится идентично', () => {
    const p = mapProduct(productRow('[{"hex":"#00ff00","name":"Зелёный"}]'));
    expect(p.colors).toEqual([{ hex: '#00ff00', name: 'Зелёный' }]);
  });

  it('name отсутствует/не строка → пустая строка (title кружка может быть пуст)', () => {
    const p = mapProduct(productRow([{ hex: '#123456' }, { hex: '#abcdef', name: 123 }]));
    expect(p.colors).toEqual([
      { hex: '#123456', name: '' },
      { hex: '#abcdef', name: '' },
    ]);
  });

  it('запись без hex отбрасывается (нечего красить)', () => {
    const p = mapProduct(productRow([{ name: 'Безцвета' }, { hex: '#fff', name: 'Белый' }]));
    expect(p.colors).toEqual([{ hex: '#fff', name: 'Белый' }]);
  });

  it('обратная совместимость: колонка отсутствует / NULL / мусор → []', () => {
    expect(mapProduct(productRow(undefined)).colors).toEqual([]);
    expect(mapProduct(productRow(null)).colors).toEqual([]);
    expect(mapProduct(productRow('not-json')).colors).toEqual([]);
    expect(mapProduct(productRow({ hex: '#fff' })).colors).toEqual([]); // объект, не массив
  });
});

// =============================================================================
// (а) ЮНИТ — DTO.
// =============================================================================
describe('storefront/dto — toProductDetailDto.colors (юнит)', () => {
  const opts = { effectiveIsNew: false, categorySlugs: [], seoCtx: SEO };

  it('прокидывает свотчи как [{hex,name}] в порядке показа', () => {
    const dto = toProductDetailDto(
      productDetail([
        { hex: '#ff0000', name: 'Красный' },
        { hex: '#0000ff', name: 'Синий' },
      ]),
      opts,
    );
    expect(dto.colors).toEqual([
      { hex: '#ff0000', name: 'Красный' },
      { hex: '#0000ff', name: 'Синий' },
    ]);
  });

  it('нет цветов → colors=[] (витрина блок не рендерит)', () => {
    const dto = toProductDetailDto(productDetail([]), opts);
    expect(dto.colors).toEqual([]);
  });

  it('DTO-массив — копия, не ссылка на доменный (наружу не утекает мутируемый источник)', () => {
    const domain = [{ hex: '#ff0000', name: 'Красный' }];
    const dto = toProductDetailDto(productDetail(domain), opts);
    expect(dto.colors).not.toBe(domain);
    expect(dto.colors[0]).not.toBe(domain[0]);
  });
});

// =============================================================================
// (а) ЮНИТ — ETL-загрузчик (чистые функции).
// =============================================================================
describe('scripts/load-product-colors — normalizeColors (юнит)', () => {
  it('отбирает валидные {hex,name}; name не строка → ""', () => {
    expect(
      normalizeColors([
        { hex: '#ff0000', name: 'Красный' },
        { hex: '#00ff00' },
        { hex: '#0000ff', name: 42 },
      ]),
    ).toEqual([
      { hex: '#ff0000', name: 'Красный' },
      { hex: '#00ff00', name: '' },
      { hex: '#0000ff', name: '' },
    ]);
  });

  it('запись без hex / пустой hex / не-массив → отбрасывается', () => {
    expect(normalizeColors([{ name: 'нет hex' }, { hex: '' }])).toEqual([]);
    expect(normalizeColors(null)).toEqual([]);
    expect(normalizeColors('x')).toEqual([]);
  });
});

describe('scripts/load-product-colors — parseSource (юнит)', () => {
  it('{slug: [...]} → Map<slug, ProductColor[]> с нормализацией', () => {
    const map = parseSource({
      'coat-red': [{ hex: '#ff0000', name: 'Красный' }],
      'coat-empty': [],
      'coat-bad': [{ name: 'без hex' }],
    });
    expect(map.get('coat-red')).toEqual([{ hex: '#ff0000', name: 'Красный' }]);
    expect(map.get('coat-empty')).toEqual([]);
    expect(map.get('coat-bad')).toEqual([]);
    expect(map.size).toBe(3);
  });

  it('не-объект (массив/строка/null) → бросает', () => {
    expect(() => parseSource([])).toThrow();
    expect(() => parseSource('x')).toThrow();
    expect(() => parseSource(null)).toThrow();
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД (:5434).
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('catalog — products.colors (интеграция, нужна БД)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  let repo: typeof import('@/lib/catalog/repository');
  const tag = 'colors-' + Math.random().toString(36).slice(2, 8);
  const productIds: string[] = [];

  beforeAll(async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    repo = await import('@/lib/catalog/repository');
  });

  afterAll(async () => {
    for (const id of productIds) await sql`DELETE FROM products WHERE id = ${id}`;
    if (closeSql) await closeSql();
  });

  it('colors round-trip: пишется jsonb и читается через getProductById', async () => {
    const value = JSON.stringify([
      { hex: '#ff0000', name: 'Красный' },
      { hex: '#00ff00', name: 'Зелёный' },
    ]);
    const rows = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, colors)
      VALUES (${`${tag}-sku`}, ${`${tag}-slug`}, ${'Товар'}, ${value}::jsonb)
      RETURNING id
    `;
    productIds.push(rows[0]!.id);
    const p = await repo.getProductById(rows[0]!.id);
    expect(p?.colors).toEqual([
      { hex: '#ff0000', name: 'Красный' },
      { hex: '#00ff00', name: 'Зелёный' },
    ]);
  });

  it('старая запись без colors → DEFAULT [] (обратная совместимость)', async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name)
      VALUES (${`${tag}-sku2`}, ${`${tag}-slug2`}, ${'Без цвета'})
      RETURNING id
    `;
    productIds.push(rows[0]!.id);
    const p = await repo.getProductById(rows[0]!.id);
    expect(p?.colors).toEqual([]);
  });
});
