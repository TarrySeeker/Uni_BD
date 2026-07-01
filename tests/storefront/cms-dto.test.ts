import { describe, expect, it } from 'vitest';

import { toPublicPageDto } from '@/lib/storefront/cms-dto';
import type { SeoCtx } from '@/lib/seo/meta';
import type { CmsPageWithSections } from '@/lib/cms/types';

/**
 * ЮНИТ (без БД/Next): toPublicPageDto отдаёт ТОЛЬКО публично-безопасные поля
 * страницы (slug/title/meta/sections), скрывая id/status/audit/timestamps/
 * revisions; секции — только enabled=true, по display_order; products_grid отдаёт
 * slug-фильтр (без FK на каталог). meta собирается через buildSeoMeta (SeoCtx).
 */

function makeSeoCtx(overrides: Partial<SeoCtx> = {}): SeoCtx {
  return {
    siteUrl: 'https://shop.example',
    titleTemplate: '%s — Магазин',
    siteName: 'Магазин',
    defaultDescription: 'Дефолтное описание',
    defaultOgImageKey: null,
    publicUrl: (k) => `https://cdn.example/${k}`,
    pathPrefix: 'page',
    ...overrides,
  };
}

function makePage(
  overrides: Partial<CmsPageWithSections> = {},
): CmsPageWithSections {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'p-1',
    slug: 'about',
    title: 'О компании',
    status: 'published',
    publishedAt: now,
    seoTitle: 'SEO О компании',
    seoDescription: 'Описание страницы',
    ogTitle: null,
    ogDescription: null,
    ogImageUrl: 'https://cdn.example/about.png',
    canonicalUrl: null,
    noindex: false,
    sitemapPriority: 0.5,
    sitemapChangefreq: 'monthly',
    createdBy: 'admin-1',
    updatedBy: 'admin-2',
    createdAt: now,
    updatedAt: now,
    sections: [],
    ...overrides,
  };
}

function section(
  over: Partial<CmsPageWithSections['sections'][number]>,
): CmsPageWithSections['sections'][number] {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 's-x',
    pageId: 'p-1',
    sectionKey: 'k',
    type: 'text',
    content: { type: 'text', html: '<p>hi</p>' },
    displayOrder: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('toPublicPageDto — публичный DTO CMS-страницы', () => {
  it('отдаёт slug/title/meta/sections и СКРЫВАЕТ внутренние поля', () => {
    const dto = toPublicPageDto(makePage(), makeSeoCtx());
    expect(dto.slug).toBe('about');
    expect(dto.title).toBe('О компании');
    expect(dto.meta).toBeTruthy();

    // Внутренние/служебные поля не должны утекать наружу.
    const keys = Object.keys(dto);
    for (const forbidden of [
      'id',
      'status',
      'createdBy',
      'updatedBy',
      'createdAt',
      'updatedAt',
      'publishedAt',
      'revisions',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('meta собирается через buildSeoMeta (title через шаблон, og:image URL)', () => {
    const dto = toPublicPageDto(makePage(), makeSeoCtx());
    expect(dto.meta.title).toBe('SEO О компании — Магазин');
    expect(dto.meta.canonical).toBe('https://shop.example/page/about');
    expect(dto.meta.ogImageUrl).toBe('https://cdn.example/about.png');
    expect(dto.meta.noindex).toBe(false);
  });

  // C18: OG-текст страницы (og_title/og_description) должен доходить до витрины,
  // а не подменяться fallback'ом. Заданные значения пробрасываются в meta.
  it('пробрасывает явные ogTitle/ogDescription страницы в meta (C18)', () => {
    const page = makePage({
      ogTitle: 'OG заголовок страницы',
      ogDescription: 'OG описание страницы',
    });
    const dto = toPublicPageDto(page, makeSeoCtx());
    expect(dto.meta.ogTitle).toBe('OG заголовок страницы');
    expect(dto.meta.ogDescription).toBe('OG описание страницы');
  });

  it('без ogTitle/ogDescription meta откатывается на title/description (fallback билдера)', () => {
    const dto = toPublicPageDto(makePage(), makeSeoCtx());
    // og_title пуст → fallback на собранный title; og_description пуст → на description.
    expect(dto.meta.ogTitle).toBe('SEO О компании — Магазин');
    expect(dto.meta.ogDescription).toBe('Описание страницы');
  });

  it('отдаёт ТОЛЬКО enabled-секции, отсортированные по display_order', () => {
    const page = makePage({
      sections: [
        section({ id: 's-3', sectionKey: 'c', displayOrder: 2, enabled: true, content: { type: 'text', html: '<p>3</p>' } }),
        section({ id: 's-off', sectionKey: 'off', displayOrder: 1, enabled: false, content: { type: 'text', html: '<p>off</p>' } }),
        section({ id: 's-1', sectionKey: 'a', displayOrder: 0, enabled: true, content: { type: 'text', html: '<p>1</p>' } }),
      ],
    });
    const dto = toPublicPageDto(page, makeSeoCtx());
    expect(dto.sections).toHaveLength(2);
    expect(dto.sections.map((s) => (s.content as { html: string }).html)).toEqual([
      '<p>1</p>',
      '<p>3</p>',
    ]);
  });

  it('секция отдаёт только { type, content } — без id/enabled/timestamps', () => {
    const page = makePage({
      sections: [section({ id: 's-1', sectionKey: 'a', displayOrder: 0 })],
    });
    const dto = toPublicPageDto(page, makeSeoCtx());
    expect(Object.keys(dto.sections[0]!).sort()).toEqual(['content', 'type']);
  });

  it('products_grid отдаёт slug-фильтр (без FK на каталог)', () => {
    const page = makePage({
      sections: [
        section({
          id: 's-pg',
          sectionKey: 'pg',
          type: 'products_grid',
          content: {
            type: 'products_grid',
            mode: 'category',
            categorySlug: 'tires',
            limit: 8,
          },
        }),
      ],
    });
    const dto = toPublicPageDto(page, makeSeoCtx());
    const content = dto.sections[0]!.content as {
      mode: string;
      categorySlug: string;
      limit: number;
    };
    expect(content.mode).toBe('category');
    expect(content.categorySlug).toBe('tires');
    expect(content.limit).toBe(8);
  });
});
