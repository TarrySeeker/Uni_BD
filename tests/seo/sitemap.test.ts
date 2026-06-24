import { describe, it, expect } from 'vitest';

import {
  buildSitemapEntries,
  type SitemapRows,
  type SitemapCtx,
} from '@/lib/seo/sitemap';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — чистый билдер buildSitemapEntries.
 *
 * Фильтрация по включённым модулям и noindex/черновикам; site_url — параметром.
 * Без чтения env/БД внутри.
 */

const CTX: SitemapCtx = { siteUrl: 'https://shop.example' };

const ROWS: SitemapRows = {
  products: [
    { slug: 'p-active', noindex: false },
    { slug: 'p-noindex', noindex: true },
  ],
  categories: [{ slug: 'c1', noindex: false }],
  brands: [{ slug: 'b1', noindex: false }],
  pages: [
    { slug: 'about', noindex: false },
    { slug: 'hidden', noindex: true },
  ],
};

describe('seo/sitemap — фильтр по модулям', () => {
  it('catalog включён → товары/категории/бренды присутствуют', () => {
    const entries = buildSitemapEntries(['catalog'], ROWS, CTX);
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://shop.example/product/p-active');
    expect(urls).toContain('https://shop.example/category/c1');
    expect(urls).toContain('https://shop.example/brand/b1');
  });

  it('catalog выключен → без товаров/категорий/брендов', () => {
    const entries = buildSitemapEntries(['cms'], ROWS, CTX);
    const urls = entries.map((e) => e.url);
    expect(urls.some((u) => u.includes('/product/'))).toBe(false);
    expect(urls.some((u) => u.includes('/category/'))).toBe(false);
    expect(urls.some((u) => u.includes('/brand/'))).toBe(false);
  });

  it('cms включён → страницы присутствуют; cms выключен → без страниц', () => {
    const withCms = buildSitemapEntries(['cms'], ROWS, CTX).map((e) => e.url);
    expect(withCms).toContain('https://shop.example/about');
    const without = buildSitemapEntries(['catalog'], ROWS, CTX).map((e) => e.url);
    expect(without).not.toContain('https://shop.example/about');
  });
});

describe('seo/sitemap — noindex/черновики', () => {
  it('noindex строки исключены', () => {
    const urls = buildSitemapEntries(['catalog', 'cms'], ROWS, CTX).map((e) => e.url);
    expect(urls).not.toContain('https://shop.example/product/p-noindex');
    expect(urls).not.toContain('https://shop.example/hidden');
  });
});

describe('seo/sitemap — корень и домен', () => {
  it('всегда содержит корень из site_url', () => {
    const urls = buildSitemapEntries([], ROWS, CTX).map((e) => e.url);
    expect(urls).toContain('https://shop.example');
  });

  it('домен берётся из переданного site_url (не хардкод)', () => {
    const urls = buildSitemapEntries(['catalog'], ROWS, {
      siteUrl: 'https://other.test',
    }).map((e) => e.url);
    expect(urls.every((u) => u.startsWith('https://other.test'))).toBe(true);
  });
});
