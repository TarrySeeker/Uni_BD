import { describe, expect, it } from 'vitest';

import {
  mapCategory,
  mapProduct,
  mapVariant,
  mapAttribute,
  mapMedia,
  mapInventory,
  mapBrand,
  mapBrandRef,
  buildCategoryTree,
} from '@/lib/catalog/repository';
import { buildAttributesCache } from '@/lib/catalog/cache';
import type { Category } from '@/lib/catalog/types';

// ЮНИТ: маппинг row(snake_case)→domain(camelCase) и сборка дерева — без БД.

describe('mapCategory', () => {
  it('маппит поля и нормализует null', () => {
    const c = mapCategory({
      id: 'c1',
      parent_id: null,
      slug: 'cat',
      name: 'Кат',
      description: 'd',
      sort: '3',
      is_active: true,
      seo_title: null,
      seo_description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
    expect(c.parentId).toBeNull();
    expect(c.sort).toBe(3);
    expect(c.isActive).toBe(true);
    expect(c.createdAt).toBeInstanceOf(Date);
  });
});

describe('mapProduct', () => {
  it('basePrice как строка, attributes_cache парсится', () => {
    const p = mapProduct({
      id: 'p1',
      sku: 'S',
      slug: 's',
      name: 'N',
      description: '',
      status: 'active',
      base_price: '199.90',
      attributes_cache: '{"color":"red"}',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(p.basePrice).toBe('199.90');
    expect(p.status).toBe('active');
    expect(p.attributesCache).toEqual({ color: 'red' });
  });

  it('новые поля: compareAtPrice/isFeatured/isNew(троичное)/brandId', () => {
    const p = mapProduct({
      id: 'p1', sku: 'S', slug: 's', name: 'N', description: '', status: 'active',
      base_price: '100.00', compare_at_price: '149.00', is_featured: true,
      is_new: null, brand_id: 'br-1', attributes_cache: {},
      created_at: new Date(), updated_at: new Date(),
    });
    expect(p.compareAtPrice).toBe('149.00');
    expect(p.isFeatured).toBe(true);
    expect(p.isNew).toBeNull(); // NULL → троичное «вычислять»
    expect(p.brandId).toBe('br-1');
  });

  it('пустые новые поля нормализуются (нет акции/бренда, is_new override)', () => {
    const p = mapProduct({
      id: 'p2', sku: 'S', slug: 's', name: 'N', status: 'draft',
      base_price: '0', compare_at_price: null, is_featured: false,
      is_new: false, brand_id: null, attributes_cache: {},
      created_at: new Date(), updated_at: new Date(),
    });
    expect(p.compareAtPrice).toBeNull();
    expect(p.isFeatured).toBe(false);
    expect(p.isNew).toBe(false);
    expect(p.brandId).toBeNull();
  });

  it('вес/габариты (0018): числа приводятся, NULL → null', () => {
    const p = mapProduct({
      id: 'p3', sku: 'S', slug: 's', name: 'N', status: 'active',
      base_price: '0', attributes_cache: {},
      weight_g: '450', length_cm: '30', width_cm: '20', height_cm: null,
      created_at: new Date(), updated_at: new Date(),
    });
    expect(p.weightG).toBe(450);
    expect(p.lengthCm).toBe(30);
    expect(p.widthCm).toBe(20);
    expect(p.heightCm).toBeNull();
  });

  it('отсутствующие колонки веса/габаритов → null (мульти-магазин без габаритов)', () => {
    const p = mapProduct({
      id: 'p4', sku: 'S', slug: 's', name: 'N', status: 'active',
      base_price: '0', attributes_cache: {},
      created_at: new Date(), updated_at: new Date(),
    });
    expect(p.weightG).toBeNull();
    expect(p.lengthCm).toBeNull();
    expect(p.widthCm).toBeNull();
    expect(p.heightCm).toBeNull();
  });
});

describe('mapVariant', () => {
  it('priceOverride null сохраняется, priceDelta строкой', () => {
    const v = mapVariant({
      id: 'v1',
      product_id: 'p1',
      sku: 'V',
      name: '',
      price_override: null,
      price_delta: '10.00',
      is_active: true,
      sort: 0,
      attributes_cache: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(v.priceOverride).toBeNull();
    expect(v.priceDelta).toBe('10.00');
  });

  it('compareAtPrice строкой или null', () => {
    const v = mapVariant({
      id: 'v2', product_id: 'p1', sku: 'V', name: '', price_override: null,
      price_delta: '0', compare_at_price: '59.99', is_active: true, sort: 0,
      attributes_cache: {}, created_at: new Date(), updated_at: new Date(),
    });
    expect(v.compareAtPrice).toBe('59.99');
    const v2 = mapVariant({
      id: 'v3', product_id: 'p1', sku: 'V', name: '', price_override: null,
      price_delta: '0', compare_at_price: null, is_active: true, sort: 0,
      attributes_cache: {}, created_at: new Date(), updated_at: new Date(),
    });
    expect(v2.compareAtPrice).toBeNull();
  });

  it('вес/габариты варианта (0018): переопределение или null', () => {
    const v = mapVariant({
      id: 'v4', product_id: 'p1', sku: 'V', name: '', price_override: null,
      price_delta: '0', is_active: true, sort: 0, attributes_cache: {},
      weight_g: '120', length_cm: null, width_cm: '8', height_cm: '3',
      created_at: new Date(), updated_at: new Date(),
    });
    expect(v.weightG).toBe(120);
    expect(v.lengthCm).toBeNull();
    expect(v.widthCm).toBe(8);
    expect(v.heightCm).toBe(3);
  });
});

describe('mapBrand / mapBrandRef', () => {
  // РЕГРЕСС (major, волна 4): реальный SQL брендов выбирает ТОЛЬКО logo_key
  // (колонки logo_url в схеме нет — миграция 0011). Маппер ОБЯЗАН прокинуть
  // logo_key → logoKey; URL логотипа резолвится из ключа на границе
  // представления (DTO/админка), как og:image (см. lib/seo/meta buildOgImageUrl).
  // Раньше mapBrand читал несуществующий row.logo_url → logoUrl навсегда null.
  it('mapBrand маппит logo_key→logoKey из РЕАЛЬНОЙ строки SQL (без logo_url)', () => {
    const b = mapBrand({
      id: 'b1', slug: 'bosch', name: 'Bosch', description: 'd', logo_key: 'k',
      is_active: true, sort: '2', seo_title: null,
      seo_description: null, created_at: new Date(), updated_at: new Date(),
    });
    expect(b.slug).toBe('bosch');
    expect(b.logoKey).toBe('k');
    expect(b.isActive).toBe(true);
    expect(b.sort).toBe(2);
  });

  it('mapBrand: logo_key=null → logoKey=null (без лого)', () => {
    const b = mapBrand({
      id: 'b2', slug: 'noname', name: 'NoName', description: '', logo_key: null,
      is_active: true, sort: '0', seo_title: null, seo_description: null,
      created_at: new Date(), updated_at: new Date(),
    });
    expect(b.logoKey).toBeNull();
  });

  it('mapBrandRef из префикса b_; null, если бренда нет', () => {
    expect(
      mapBrandRef({ b_id: null, b_slug: null, b_name: null, b_logo_key: null }),
    ).toBeNull();
    // Реальный JOIN отдаёт ТОЛЬКО b_logo_key — маппер обязан прокинуть его в logoKey.
    const ref = mapBrandRef({
      b_id: 'b1', b_slug: 'kyb', b_name: 'KYB', b_logo_key: 'lk',
    });
    expect(ref).toEqual({ id: 'b1', slug: 'kyb', name: 'KYB', logoKey: 'lk' });
  });
});

describe('mapAttribute / mapMedia / mapInventory', () => {
  it('булевы и числа приводятся', () => {
    const a = mapAttribute({
      id: 'a', code: 'color', name: 'Цвет', type: 'select', unit: null,
      is_variant: true, is_filterable: false, is_required: false, sort: '1',
      created_at: new Date(), updated_at: new Date(),
    });
    expect(a.isVariant).toBe(true);
    expect(a.isFilterable).toBe(false);
    expect(a.sort).toBe(1);

    const m = mapMedia({
      id: 'm', product_id: 'p', variant_id: null, storage_key: 'k', url: 'u',
      type: 'image', mime: 'image/webp', alt: '', width: '800', height: '600',
      size_bytes: '1234', sort: 0, is_primary: true, created_at: new Date(),
    });
    expect(m.width).toBe(800);
    expect(m.sizeBytes).toBe(1234);
    expect(m.isPrimary).toBe(true);

    const i = mapInventory({
      id: 'i', product_id: 'p', variant_id: 'v', warehouse_code: 'main',
      quantity: '5', reserved: '2', updated_at: new Date(),
    });
    expect(i.quantity).toBe(5);
    expect(i.reserved).toBe(2);
  });
});

describe('buildCategoryTree', () => {
  function cat(id: string, parentId: string | null, sort = 0): Category {
    return {
      id, parentId, slug: id, name: id, description: '', sort, isActive: true,
      seoTitle: null, seoDescription: null,
      ogTitle: null, ogDescription: null, ogImageKey: null, canonicalUrl: null, noindex: false,
      createdAt: new Date(), updatedAt: new Date(),
    };
  }

  it('собирает иерархию из плоского списка', () => {
    const tree = buildCategoryTree([
      cat('a', null), cat('b', 'a'), cat('c', 'a'), cat('d', 'b'), cat('e', null),
    ]);
    const ids = tree.map((n) => n.id).sort();
    expect(ids).toEqual(['a', 'e']);
    const a = tree.find((n) => n.id === 'a')!;
    expect(a.children.map((c) => c.id).sort()).toEqual(['b', 'c']);
    const b = a.children.find((c) => c.id === 'b')!;
    expect(b.children.map((c) => c.id)).toEqual(['d']);
  });

  it('сирота с несуществующим родителем становится корнем', () => {
    const tree = buildCategoryTree([cat('x', 'missing')]);
    expect(tree.map((n) => n.id)).toEqual(['x']);
  });
});

describe('buildAttributesCache', () => {
  it('одно значение → скаляр, несколько → массив', () => {
    const cache = buildAttributesCache([
      { code: 'color', value: 'red' },
      { code: 'size', value: 'M' },
      { code: 'size', value: 'L' },
    ]);
    expect(cache.color).toBe('red');
    expect(cache.size).toEqual(['M', 'L']);
  });
  it('пустой вход → пустой объект', () => {
    expect(buildAttributesCache([])).toEqual({});
  });
});
