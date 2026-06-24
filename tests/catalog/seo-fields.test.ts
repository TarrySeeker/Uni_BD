import { describe, it, expect } from 'vitest';

import {
  ProductUpdateSchema,
  CategoryUpdateSchema,
  BrandUpdateSchema,
} from '@/lib/catalog/schemas';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — расширение схем каталога SEO-полями
 * seoTitle/seoDescription/ogTitle/ogDescription/ogImageKey/canonicalUrl/noindex.
 *
 * canonical_url: абсолютный https ок; относительный с / ок; мусор → validation.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

describe('catalog/schemas — SEO-поля приняты', () => {
  it('ProductUpdate принимает все SEO-поля', () => {
    const r = ProductUpdateSchema.safeParse({
      id: UUID,
      ogTitle: 'OG',
      ogDescription: 'OG desc',
      ogImageKey: 'products/1/og.webp',
      canonicalUrl: 'https://shop.example/p/x',
      noindex: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ogTitle).toBe('OG');
      expect(r.data.canonicalUrl).toBe('https://shop.example/p/x');
      expect(r.data.noindex).toBe(true);
    }
  });

  it('CategoryUpdate принимает SEO-поля', () => {
    const r = CategoryUpdateSchema.safeParse({ id: UUID, canonicalUrl: '/category/x', noindex: false });
    expect(r.success).toBe(true);
  });

  it('BrandUpdate принимает SEO-поля', () => {
    const r = BrandUpdateSchema.safeParse({ id: UUID, ogImageKey: 'brands/1/og.webp' });
    expect(r.success).toBe(true);
  });
});

describe('catalog/schemas — canonical_url валидация', () => {
  it('абсолютный https → ок', () => {
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, canonicalUrl: 'https://x.io/p' }).success,
    ).toBe(true);
  });

  it('относительный с ведущим / → ок', () => {
    expect(ProductUpdateSchema.safeParse({ id: UUID, canonicalUrl: '/p/x' }).success).toBe(true);
  });

  it('javascript: → validation', () => {
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, canonicalUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });

  it('относительный без ведущего / → validation', () => {
    expect(ProductUpdateSchema.safeParse({ id: UUID, canonicalUrl: 'p/x' }).success).toBe(false);
  });

  it('http:// без https → validation', () => {
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, canonicalUrl: 'http://x.io/p' }).success,
    ).toBe(false);
  });
});
