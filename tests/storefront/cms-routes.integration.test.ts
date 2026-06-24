import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { CmsPageWithSections } from '@/lib/cms/types';

/**
 * Тесты пакета 5.C-2 (docs/11 §5.1.6) — Storefront-роуты /api/storefront/v1/pages.
 *
 * Репозиторий и эффективные настройки замоканы (без БД) — проверяем поведение
 * самих роутов: гейт module:'cms' (выкл → 404 module_disabled), auth/CORS,
 * published → 200 + публичный DTO (без id/status), draft/archived → 404 not_found,
 * OPTIONS preflight. Имя *.integration сохранено по плану §5.1.6; реальной БД не
 * требует (репозиторий инъектируется моком) — поэтому не под skipIf.
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;

const now = new Date('2026-01-01T00:00:00Z');

function publishedPage(): CmsPageWithSections {
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
        id: 's-1',
        pageId: 'page-secret-id',
        sectionKey: 'intro',
        type: 'text',
        content: { type: 'text', html: '<p>hi</p>' },
        displayOrder: 0,
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
  // Авторитетный гейт модуля теперь живёт в @/lib/config/settings и вызывается из
  // runStorefront. Без БД-оверрайда он эквивалентен env-набору — отражаем
  // process.env.ADMIK_MODULES, чтобы env-driven кейсы (выкл cms → 404) сохранились.
  isModuleEffectivelyEnabled: vi.fn(async (name: string) => {
    const raw = process.env.ADMIK_MODULES?.trim();
    if (!raw) return true; // не задано → все модули включены (env-дефолт)
    return raw
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .includes(name);
  }),
};

async function loadSlugRoute() {
  vi.resetModules();
  vi.doMock('@/lib/cms/repository', () => repoMock);
  vi.doMock('@/lib/config/settings', () => settingsMock);
  vi.doMock('@/lib/storage', () => ({ getStorage: () => ({ url: (k: string) => `https://cdn/${k}` }) }));
  return import('@/app/api/storefront/v1/pages/[slug]/route');
}

async function loadListRoute() {
  vi.resetModules();
  vi.doMock('@/lib/cms/repository', () => repoMock);
  vi.doMock('@/lib/config/settings', () => settingsMock);
  vi.doMock('@/lib/storage', () => ({ getStorage: () => ({ url: (k: string) => `https://cdn/${k}` }) }));
  return import('@/app/api/storefront/v1/pages/route');
}

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

describe('GET /api/storefront/v1/pages/[slug] — module:cms', () => {
  beforeEach(() => {
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    repoMock.getPublishedCmsPageBySlug.mockReset();
    repoMock.listPublishedCmsPages.mockReset();
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

  it('модуль cms выключен → 404 module_disabled', async () => {
    process.env.ADMIK_MODULES = 'catalog'; // без cms
    const { GET } = await loadSlugRoute();
    const req = new Request('http://x/api/storefront/v1/pages/about', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req, ctx('about'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('module_disabled');
    expect(repoMock.getPublishedCmsPageBySlug).not.toHaveBeenCalled();
  });

  it('без ключа/origin → 401 unauthorized', async () => {
    process.env.ADMIK_MODULES = 'cms';
    const { GET } = await loadSlugRoute();
    const res = await GET(
      new Request('http://x/api/storefront/v1/pages/about'),
      ctx('about'),
    );
    expect(res.status).toBe(401);
  });

  it('published → 200 + публичный DTO (без id/status/audit), CORS', async () => {
    process.env.ADMIK_MODULES = 'cms';
    repoMock.getPublishedCmsPageBySlug.mockResolvedValue(publishedPage());
    const { GET } = await loadSlugRoute();
    const req = new Request('http://x/api/storefront/v1/pages/about', {
      headers: { 'x-storefront-key': 'sk_secret', origin: 'https://demo.example' },
    });
    const res = await GET(req, ctx('about'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    const text = await res.text();
    expect(text).not.toContain('page-secret-id');
    expect(text).not.toContain('admin-secret');
    expect(text).not.toContain('"status"');
    const body = JSON.parse(text) as {
      data: { slug: string; title: string; sections: unknown[] };
    };
    expect(body.data.slug).toBe('about');
    expect(body.data.title).toBe('О компании');
    expect(Array.isArray(body.data.sections)).toBe(true);
  });

  it('draft/archived (репозиторий вернул null) → 404 not_found', async () => {
    process.env.ADMIK_MODULES = 'cms';
    repoMock.getPublishedCmsPageBySlug.mockResolvedValue(null);
    const { GET } = await loadSlugRoute();
    const req = new Request('http://x/api/storefront/v1/pages/draft-page', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req, ctx('draft-page'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('OPTIONS → 204 preflight', async () => {
    const { OPTIONS } = await loadSlugRoute();
    const req = new Request('http://x/api/storefront/v1/pages/about', {
      method: 'OPTIONS',
      headers: { origin: 'https://demo.example', 'access-control-request-method': 'GET' },
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
  });
});

describe('GET /api/storefront/v1/pages — список опубликованных', () => {
  beforeEach(() => {
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    repoMock.listPublishedCmsPages.mockReset();
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

  it('модуль cms выключен → 404 module_disabled', async () => {
    process.env.ADMIK_MODULES = 'catalog';
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request('http://x/api/storefront/v1/pages', {
        headers: { 'x-storefront-key': 'sk_secret' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('cms включён → 200 + список slug/title/meta', async () => {
    process.env.ADMIK_MODULES = 'cms';
    repoMock.listPublishedCmsPages.mockResolvedValue([
      {
        id: 'secret',
        slug: 'about',
        title: 'О компании',
        status: 'published',
        publishedAt: now,
        seoTitle: 'About',
        seoDescription: 'd',
        ogImageUrl: null,
        canonicalUrl: null,
        noindex: false,
        sitemapPriority: null,
        sitemapChangefreq: null,
        createdBy: null,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const { GET } = await loadListRoute();
    const req = new Request('http://x/api/storefront/v1/pages', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('secret');
    const body = JSON.parse(text) as {
      data: { slug: string; title: string }[];
    };
    expect(body.data[0]!.slug).toBe('about');
    expect(body.data[0]!.title).toBe('О компании');
  });
});
