import { describe, expect, it } from 'vitest';

import { toPublicPageDto } from '@/lib/storefront/cms-dto';
import type { SeoCtx } from '@/lib/seo/meta';
import type { CmsPageWithSections } from '@/lib/cms/types';

/**
 * БАГ #1 (data-integrity): toPublicSectionDto отдавал content секции ДОСЛОВНО,
 * включая сырой ключ S3/MinIO `imageKey` (hero/banner) и `images[].imageKey`
 * (gallery). Это нарушает инвариант «витрине НЕ раскрываем storage_key» и отдаёт
 * непригодный для рендера ключ вместо публичного URL.
 *
 * ФИКС: toPublicPageDto/toPublicSectionDto принимают резолвер publicUrl и
 * заменяют imageKey → imageUrl (абсолютный URL), удаляя сырой ключ — зеркально
 * каталог-медиа (toMediaDto отдаёт url, не storage_key).
 *
 * ЮНИТ без БД/Next — чистая функция.
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
    ogImageUrl: null,
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

/** Резолвер ключ→URL, имитирующий storage.url (как роуты). */
const publicUrl = (k: string) => `https://cdn.example/${k}`;

describe('toPublicPageDto — НЕ раскрывает storage_key секций (баг #1)', () => {
  it('hero: imageKey заменён на абсолютный imageUrl, сырого ключа нет', () => {
    const page = makePage({
      sections: [
        section({
          id: 's-hero',
          sectionKey: 'hero',
          type: 'hero',
          content: {
            type: 'hero',
            title: 'Заголовок',
            imageKey: 'cms/hero/abc.webp',
            ctaLabel: 'Купить',
            ctaHref: '/shop',
          },
        }),
      ],
    });

    const dto = toPublicPageDto(page, makeSeoCtx(), publicUrl);
    const content = dto.sections[0]!.content;

    expect(content).not.toHaveProperty('imageKey');
    expect((content as { imageUrl: string }).imageUrl).toBe(
      'https://cdn.example/cms/hero/abc.webp',
    );
    // Прочие поля сохранены без изменений.
    expect((content as { title: string }).title).toBe('Заголовок');
    expect((content as { ctaHref: string }).ctaHref).toBe('/shop');
  });

  it('banner: imageKey заменён на абсолютный imageUrl, сырого ключа нет', () => {
    const page = makePage({
      sections: [
        section({
          id: 's-banner',
          sectionKey: 'banner',
          type: 'banner',
          content: {
            type: 'banner',
            imageKey: 'cms/banner/promo.webp',
            href: '/sale',
            alt: 'Распродажа',
          },
        }),
      ],
    });

    const dto = toPublicPageDto(page, makeSeoCtx(), publicUrl);
    const content = dto.sections[0]!.content;

    expect(content).not.toHaveProperty('imageKey');
    expect((content as { imageUrl: string }).imageUrl).toBe(
      'https://cdn.example/cms/banner/promo.webp',
    );
    expect((content as { alt: string }).alt).toBe('Распродажа');
  });

  it('gallery: каждый images[].imageKey заменён на imageUrl, сырых ключей нет', () => {
    const page = makePage({
      sections: [
        section({
          id: 's-gallery',
          sectionKey: 'gallery',
          type: 'gallery',
          content: {
            type: 'gallery',
            images: [
              { imageKey: 'cms/g/1.webp', alt: 'Фото 1' },
              { imageKey: 'cms/g/2.webp' },
            ],
          },
        }),
      ],
    });

    const dto = toPublicPageDto(page, makeSeoCtx(), publicUrl);
    const images = (dto.sections[0]!.content as {
      images: Array<Record<string, unknown>>;
    }).images;

    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img).not.toHaveProperty('imageKey');
    }
    expect(images[0]!.imageUrl).toBe('https://cdn.example/cms/g/1.webp');
    expect(images[0]!.alt).toBe('Фото 1');
    expect(images[1]!.imageUrl).toBe('https://cdn.example/cms/g/2.webp');
  });

  it('весь сериализованный DTO НЕ содержит подстроки "imageKey"', () => {
    const page = makePage({
      sections: [
        section({
          id: 's-hero',
          sectionKey: 'hero',
          type: 'hero',
          content: { type: 'hero', title: 'T', imageKey: 'cms/hero/x.webp' },
        }),
        section({
          id: 's-gallery',
          sectionKey: 'gallery',
          type: 'gallery',
          displayOrder: 1,
          content: {
            type: 'gallery',
            images: [{ imageKey: 'cms/g/1.webp' }],
          },
        }),
      ],
    });

    const json = JSON.stringify(toPublicPageDto(page, makeSeoCtx(), publicUrl));
    expect(json).not.toContain('imageKey');
    expect(json).toContain('imageUrl');
  });

  it('секции без изображений (text/products_grid) проходят без изменений', () => {
    const page = makePage({
      sections: [
        section({
          id: 's-text',
          sectionKey: 'text',
          type: 'text',
          content: { type: 'text', html: '<p>контент</p>' },
        }),
        section({
          id: 's-pg',
          sectionKey: 'pg',
          type: 'products_grid',
          displayOrder: 1,
          content: {
            type: 'products_grid',
            mode: 'category',
            categorySlug: 'tires',
            limit: 8,
          },
        }),
      ],
    });

    const dto = toPublicPageDto(page, makeSeoCtx(), publicUrl);
    expect((dto.sections[0]!.content as { html: string }).html).toBe(
      '<p>контент</p>',
    );
    const pg = dto.sections[1]!.content as {
      mode: string;
      categorySlug: string;
    };
    expect(pg.mode).toBe('category');
    expect(pg.categorySlug).toBe('tires');
  });
});
