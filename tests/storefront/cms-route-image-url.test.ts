import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { CmsPageWithSections } from '@/lib/cms/types';

/**
 * БАГ #1 на уровне роута GET /api/storefront/v1/pages/[slug]: тело ответа НЕ
 * содержит сырого ключа `imageKey` секций, а содержит абсолютный `imageUrl`,
 * собранный через storage.url. Репозиторий/настройки/хранилище замоканы (без БД).
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;

const now = new Date('2026-01-01T00:00:00Z');

function pageWithImages(): CmsPageWithSections {
  return {
    id: 'page-secret-id',
    slug: 'about',
    title: 'О компании',
    status: 'published',
    publishedAt: now,
    seoTitle: 'SEO About',
    seoDescription: 'desc',
    ogImageUrl: null,
    canonicalUrl: null,
    noindex: false,
    sitemapPriority: null,
    sitemapChangefreq: null,
    createdBy: 'admin-secret',
    updatedBy: 'admin-secret',
    createdAt: now,
    updatedAt: now,
    sections: [
      {
        id: 's-hero',
        pageId: 'page-secret-id',
        sectionKey: 'hero',
        type: 'hero',
        content: { type: 'hero', title: 'T', imageKey: 'cms/hero/secret-key.webp' },
        displayOrder: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 's-gallery',
        pageId: 'page-secret-id',
        sectionKey: 'gallery',
        type: 'gallery',
        content: {
          type: 'gallery',
          images: [{ imageKey: 'cms/g/secret-1.webp', alt: 'Фото' }],
        },
        displayOrder: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

const repoMock = {
  getPublishedCmsPageBySlug: vi.fn(),
  listPublishedCmsPages: vi.fn(),
};

const settingsMock = {
  getEffectiveSettings: vi.fn(async () => ({
    seo: { title_template: '%s', noindex_site: false, site_url: 'https://shop.example' },
  })),
  // Авторитетный гейт модуля (вызывается из runStorefront). Тест проверяет
  // успешный путь cms → 200, поэтому модуль включён.
  isModuleEffectivelyEnabled: vi.fn(async () => true),
};

async function loadSlugRoute() {
  vi.resetModules();
  vi.doMock('@/lib/cms/repository', () => repoMock);
  vi.doMock('@/lib/config/settings', () => settingsMock);
  vi.doMock('@/lib/storage', () => ({
    getStorage: () => ({ url: (k: string) => `https://cdn.example/${k}` }),
  }));
  return import('@/app/api/storefront/v1/pages/[slug]/route');
}

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

describe('GET /pages/[slug] — секции отдают imageUrl, НЕ imageKey (баг #1)', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'cms';
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    repoMock.getPublishedCmsPageBySlug.mockReset();
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
    vi.doUnmock('@/lib/cms/repository');
    vi.doUnmock('@/lib/config/settings');
    vi.doUnmock('@/lib/storage');
    vi.resetModules();
  });

  it('тело ответа НЕ содержит imageKey, содержит абсолютный imageUrl', async () => {
    repoMock.getPublishedCmsPageBySlug.mockResolvedValue(pageWithImages());
    const { GET } = await loadSlugRoute();
    const req = new Request('http://x/api/storefront/v1/pages/about', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req, ctx('about'));
    expect(res.status).toBe(200);

    const text = await res.text();
    // Поля сырого ключа `imageKey` не должно быть нигде в ответе (инвариант:
    // витрине отдаём публичный URL, а не storage_key). Сам ключ как СЕГМЕНТ
    // абсолютного URL — допустим (это путь объекта в публичном CDN).
    expect(text).not.toContain('imageKey');

    const body = JSON.parse(text) as {
      data: { sections: Array<{ type: string; content: Record<string, unknown> }> };
    };
    const hero = body.data.sections.find((s) => s.type === 'hero')!;
    expect(hero.content.imageUrl).toBe(
      'https://cdn.example/cms/hero/secret-key.webp',
    );
    const gallery = body.data.sections.find((s) => s.type === 'gallery')!;
    const images = gallery.content.images as Array<Record<string, unknown>>;
    expect(images[0]!.imageUrl).toBe('https://cdn.example/cms/g/secret-1.webp');
    expect(images[0]).not.toHaveProperty('imageKey');
  });
});
