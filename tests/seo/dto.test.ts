import { describe, it, expect } from 'vitest';

import {
  toProductDetailDto,
  toFullBrandDto,
  toCategoryDto,
  type SeoMetaDto,
} from '@/lib/storefront/dto';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import type { ProductDetail, Brand, Category } from '@/lib/catalog/types';
import type { SeoCtx } from '@/lib/seo/meta';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — наличие meta в DTO и НЕ-утечка
 * og_image_key наружу (только ogImageUrl). seoCtx инъецируется параметром.
 */

const SEO_CTX: SeoCtx = {
  siteUrl: 'https://shop.example',
  titleTemplate: '%s — Магазин',
  siteName: 'Магазин',
  defaultDescription: 'Описание',
  defaultOgImageKey: null,
  publicUrl: (key: string) => `https://cdn.example/${key}`,
  pathPrefix: 'product',
};

function makeProduct(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: 'p1',
    sku: 'SKU1',
    slug: 'prod-1',
    name: 'Товар',
    description: 'desc',
    status: 'active',
    basePrice: '100.00',
    compareAtPrice: null,
    isFeatured: false,
    isNew: null,
    brandId: null,
    attributesCache: {},
    seoTitle: 'SEO товар',
    seoDescription: 'SEO опис',
    ogTitle: null,
    ogDescription: null,
    ogImageKey: 'products/p1/og.webp',
    canonicalUrl: null,
    noindex: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    brand: null,
    variants: [],
    media: [],
    inventory: [],
    ...over,
  } as ProductDetail;
}

describe('storefront/dto — ProductDetailDto.meta', () => {
  it('meta присутствует и собран из seoCtx', () => {
    const dto = toProductDetailDto(makeProduct(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO_CTX,
    });
    const meta: SeoMetaDto = dto.meta;
    expect(meta.title).toBe('SEO товар — Магазин');
    expect(meta.canonical).toBe('https://shop.example/product/prod-1');
    expect(meta.ogImageUrl).toBe('https://cdn.example/products/p1/og.webp');
    expect(meta.noindex).toBe(false);
  });

  it('og_image_key НЕ утекает наружу (только ogImageUrl)', () => {
    const dto = toProductDetailDto(makeProduct(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO_CTX,
    });
    const serialized = JSON.stringify(dto);
    // Ключ S3 не утекает как поле (ни camelCase, ни snake_case) — только URL.
    expect(serialized).not.toContain('ogImageKey');
    expect(serialized).not.toContain('og_image_key');
    expect(dto).not.toHaveProperty('ogImageKey');
    expect(dto.meta).not.toHaveProperty('ogImageKey');
    // Наружу — собранный URL через storage.publicUrl (домен не хардкодим).
    expect(dto.meta.ogImageUrl).toBe('https://cdn.example/products/p1/og.webp');
  });
});

describe('storefront/dto — FullBrandDto.meta / CategoryDto.meta', () => {
  it('FullBrandDto содержит meta с pathPrefix brand', () => {
    const brand: Brand = {
      id: 'b1',
      slug: 'brembo',
      name: 'Brembo',
      description: '',
      logoKey: null,
      isActive: true,
      sort: 0,
      seoTitle: null,
      seoDescription: null,
      ogTitle: null,
      ogDescription: null,
      ogImageKey: null,
      canonicalUrl: null,
      noindex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Brand;
    const dto = toFullBrandDto(brand, { seoCtx: { ...SEO_CTX, pathPrefix: 'brand' } });
    expect(dto.meta.canonical).toBe('https://shop.example/brand/brembo');
    expect(dto.meta.title).toBe('Brembo — Магазин');
  });

  it('CategoryDto содержит meta', () => {
    const cat: Category = {
      id: 'c1',
      parentId: null,
      slug: 'shoes',
      name: 'Обувь',
      description: '',
      sort: 0,
      isActive: true,
      seoTitle: null,
      seoDescription: null,
      ogTitle: null,
      ogDescription: null,
      ogImageKey: null,
      canonicalUrl: null,
      noindex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Category;
    const dto = toCategoryDto(cat, { seoCtx: { ...SEO_CTX, pathPrefix: 'category' } });
    expect(dto.meta?.canonical).toBe('https://shop.example/category/shoes');
  });
});

describe('storefront/seo-ctx — buildEntitySeoCtx', () => {
  it('собирает SeoCtx из эффективных настроек + publicUrl + pathPrefix', () => {
    const ctx = buildEntitySeoCtx(
      {
        seo: {
          site_url: 'https://my.shop',
          title_template: '%s | My',
          site_name: 'My',
          default_description: 'D',
          default_og_image_key: 'def.webp',
          noindex_site: false,
        },
      } as any,
      (key: string) => `https://files/${key}`,
      'product',
    );
    expect(ctx.siteUrl).toBe('https://my.shop');
    expect(ctx.titleTemplate).toBe('%s | My');
    expect(ctx.pathPrefix).toBe('product');
    expect(ctx.publicUrl('x')).toBe('https://files/x');
    expect(ctx.defaultOgImageKey).toBe('def.webp');
  });
});
