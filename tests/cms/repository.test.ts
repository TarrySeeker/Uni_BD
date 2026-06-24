import { describe, expect, it } from 'vitest';

import { mapCmsPage, mapCmsSection } from '@/lib/cms/repository';

/**
 * Тесты пакета 5.C-1 (docs/11 §5.1.6) — чистые мапперы row(snake)→domain(camel).
 *
 * Проверяем маппинг полей и дефолты без БД (как mapProduct/mapCategory).
 */

describe('cms/repository — mapCmsPage', () => {
  const baseRow = {
    id: 'p-1',
    slug: 'about',
    title: 'О компании',
    status: 'published',
    published_at: '2026-01-02T03:04:05.000Z',
    seo_title: 'SEO заголовок',
    seo_description: 'SEO описание',
    og_image_url: 'https://cdn/og.jpg',
    canonical_url: 'https://shop/about',
    noindex: true,
    sitemap_priority: '0.8',
    sitemap_changefreq: 'weekly',
    created_by: 'u-1',
    updated_by: 'u-2',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };

  it('маппит snake_case → camelCase', () => {
    const p = mapCmsPage(baseRow);
    expect(p.id).toBe('p-1');
    expect(p.slug).toBe('about');
    expect(p.title).toBe('О компании');
    expect(p.status).toBe('published');
    expect(p.seoTitle).toBe('SEO заголовок');
    expect(p.seoDescription).toBe('SEO описание');
    expect(p.ogImageUrl).toBe('https://cdn/og.jpg');
    expect(p.canonicalUrl).toBe('https://shop/about');
    expect(p.noindex).toBe(true);
    expect(p.sitemapPriority).toBe(0.8);
    expect(p.sitemapChangefreq).toBe('weekly');
    expect(p.createdBy).toBe('u-1');
    expect(p.updatedBy).toBe('u-2');
    expect(p.publishedAt).toBeInstanceOf(Date);
    expect(p.createdAt).toBeInstanceOf(Date);
    expect(p.updatedAt).toBeInstanceOf(Date);
  });

  it('дефолты для NULL-полей', () => {
    const p = mapCmsPage({
      id: 'p-2',
      slug: 'draft-page',
      title: 'Черновик',
      status: 'draft',
      published_at: null,
      seo_title: null,
      seo_description: null,
      og_image_url: null,
      canonical_url: null,
      noindex: false,
      sitemap_priority: null,
      sitemap_changefreq: null,
      created_by: null,
      updated_by: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(p.publishedAt).toBeNull();
    expect(p.seoTitle).toBeNull();
    expect(p.ogImageUrl).toBeNull();
    expect(p.canonicalUrl).toBeNull();
    expect(p.noindex).toBe(false);
    expect(p.sitemapPriority).toBeNull();
    expect(p.sitemapChangefreq).toBeNull();
    expect(p.createdBy).toBeNull();
    expect(p.updatedBy).toBeNull();
  });

  it('noindex приводится к boolean', () => {
    expect(mapCmsPage({ ...baseRow, noindex: false }).noindex).toBe(false);
    expect(mapCmsPage({ ...baseRow, noindex: true }).noindex).toBe(true);
  });
});

describe('cms/repository — mapCmsSection', () => {
  it('маппит секцию snake_case → camelCase + парсит content', () => {
    const s = mapCmsSection({
      id: 's-1',
      page_id: 'p-1',
      section_key: 'intro',
      type: 'text',
      content: { type: 'text', html: '<p>x</p>' },
      display_order: 3,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
    expect(s.id).toBe('s-1');
    expect(s.pageId).toBe('p-1');
    expect(s.sectionKey).toBe('intro');
    expect(s.type).toBe('text');
    expect(s.content).toEqual({ type: 'text', html: '<p>x</p>' });
    expect(s.displayOrder).toBe(3);
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBeInstanceOf(Date);
    expect(s.updatedAt).toBeInstanceOf(Date);
  });

  it('content как JSON-строка парсится в объект', () => {
    const s = mapCmsSection({
      id: 's-2',
      page_id: 'p-1',
      section_key: 'hero',
      type: 'hero',
      content: '{"type":"hero","title":"Привет"}',
      display_order: 0,
      enabled: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(s.content).toEqual({ type: 'hero', title: 'Привет' });
    expect(s.enabled).toBe(false);
  });

  it('дефолты: пустой/битый content → {}, display_order → 0', () => {
    const s = mapCmsSection({
      id: 's-3',
      page_id: 'p-1',
      section_key: 'broken',
      type: 'text',
      content: null,
      display_order: null,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(s.content).toEqual({});
    expect(s.displayOrder).toBe(0);
  });
});
