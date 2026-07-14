import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { NewsArticle, NewsListRow } from '@/lib/news/types';

/**
 * Storefront-роуты /api/storefront/v1/news (docs/24 §3). Репозиторий и настройки
 * замоканы (без БД) — проверяем поведение самих роутов: гейт module:'news'
 * (выкл → 404), auth/CORS, лента (пагинация + только published в SQL), деталь
 * (published → 200 публичный DTO без служебных полей; null → 404), OPTIONS.
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;

const now = new Date('2026-07-01T00:00:00Z');

function detail(): NewsArticle {
  return {
    id: 'news-secret-id', slug: 'welcome', title: 'Привет', groupLabel: 'Анонсы',
    excerpt: 'анонс', body: '<p>тело</p>', coverImageKey: 'news/c.webp',
    status: 'published', publishedAt: now, sortOrder: 0,
    seoTitle: null, seoDescription: null, ogTitle: null, ogDescription: null,
    ogImageKey: null, noindex: false, canonicalUrl: null, translations: {},
    createdBy: 'admin-secret', updatedBy: 'admin-secret', createdAt: now, updatedAt: now,
  };
}

function listRow(slug: string): NewsListRow {
  return {
    id: 'row-secret-' + slug, slug, title: 'Заголовок ' + slug, groupLabel: null,
    excerpt: null, coverImageKey: null, status: 'published', publishedAt: now,
    sortOrder: 0, seoTitle: null, seoDescription: null, ogTitle: null,
    ogDescription: null, ogImageKey: null, noindex: false, canonicalUrl: null,
    translations: {}, updatedAt: now,
  };
}

const repoMock = {
  getPublishedNews: vi.fn(),
  getPublishedNewsBySlug: vi.fn(),
};

const settingsMock = {
  getEffectiveSettings: vi.fn(async () => ({
    seo: { title_template: '%s', noindex_site: false, site_url: 'https://shop.example' },
  })),
  isModuleEffectivelyEnabled: vi.fn(async (name: string) => {
    const raw = process.env.ADMIK_MODULES?.trim();
    if (!raw) return true;
    return raw.split(',').map((m) => m.trim().toLowerCase()).includes(name);
  }),
};

function mocks() {
  vi.resetModules();
  vi.doMock('@/lib/news/repository', () => repoMock);
  vi.doMock('@/lib/config/settings', () => settingsMock);
  vi.doMock('@/lib/storage', () => ({ getStorage: () => ({ url: (k: string) => `https://cdn/${k}` }) }));
}
async function loadListRoute() {
  mocks();
  return import('@/app/api/storefront/v1/news/route');
}
async function loadSlugRoute() {
  mocks();
  return import('@/app/api/storefront/v1/news/[slug]/route');
}
function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function restore() {
  process.env.ADMIK_MODULES = ORIGINAL_MODULES;
  process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
  process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
  vi.doUnmock('@/lib/news/repository');
  vi.doUnmock('@/lib/config/settings');
  vi.doUnmock('@/lib/storage');
  vi.resetModules();
}

describe('GET /api/storefront/v1/news — лента', () => {
  beforeEach(() => {
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    repoMock.getPublishedNews.mockReset();
  });
  afterEach(restore);

  it('модуль news выключен → 404 module_disabled', async () => {
    process.env.ADMIK_MODULES = 'catalog'; // без news
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request('http://x/api/storefront/v1/news', { headers: { 'x-storefront-key': 'sk_secret' } }),
    );
    expect(res.status).toBe(404);
    expect(repoMock.getPublishedNews).not.toHaveBeenCalled();
  });

  it('без ключа → 401', async () => {
    process.env.ADMIK_MODULES = 'news';
    const { GET } = await loadListRoute();
    const res = await GET(new Request('http://x/api/storefront/v1/news'));
    expect(res.status).toBe(401);
  });

  it('news включён → 200 + pagination; limit/offset проброшены в репозиторий', async () => {
    process.env.ADMIK_MODULES = 'news';
    repoMock.getPublishedNews.mockResolvedValue({
      rows: [listRow('a'), listRow('b')],
      total: 5,
    });
    const { GET } = await loadListRoute();
    const req = new Request('http://x/api/storefront/v1/news?limit=2&offset=2', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as {
      data: unknown[];
      pagination: { total: number; limit: number; offset: number; count: number };
    };
    expect(body.pagination).toEqual({ total: 5, limit: 2, offset: 2, count: 2 });
    // Репозиторий фильтрует только published (в SQL) — роут вызывает getPublishedNews.
    expect(repoMock.getPublishedNews).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, offset: 2 }),
    );
  });
});

describe('GET /api/storefront/v1/news/[slug] — деталь', () => {
  beforeEach(() => {
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
    repoMock.getPublishedNewsBySlug.mockReset();
  });
  afterEach(restore);

  it('модуль выключен → 404', async () => {
    process.env.ADMIK_MODULES = 'catalog';
    const { GET } = await loadSlugRoute();
    const res = await GET(
      new Request('http://x/api/storefront/v1/news/welcome', { headers: { 'x-storefront-key': 'sk_secret' } }),
      ctx('welcome'),
    );
    expect(res.status).toBe(404);
    expect(repoMock.getPublishedNewsBySlug).not.toHaveBeenCalled();
  });

  it('published → 200 публичный DTO без служебных полей', async () => {
    process.env.ADMIK_MODULES = 'news';
    repoMock.getPublishedNewsBySlug.mockResolvedValue(detail());
    const { GET } = await loadSlugRoute();
    const res = await GET(
      new Request('http://x/api/storefront/v1/news/welcome', {
        headers: { 'x-storefront-key': 'sk_secret', origin: 'https://demo.example' },
      }),
      ctx('welcome'),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('news-secret-id');
    expect(text).not.toContain('admin-secret');
    expect(text).not.toContain('"status"');
    const body = JSON.parse(text) as { data: { slug: string; title: string; body: string; coverUrl: string } };
    expect(body.data.slug).toBe('welcome');
    expect(body.data.body).toBe('<p>тело</p>');
    expect(body.data.coverUrl).toBe('https://cdn/news/c.webp');
  });

  it('draft/архив (репозиторий вернул null) → 404 not_found', async () => {
    process.env.ADMIK_MODULES = 'news';
    repoMock.getPublishedNewsBySlug.mockResolvedValue(null);
    const { GET } = await loadSlugRoute();
    const res = await GET(
      new Request('http://x/api/storefront/v1/news/draft', { headers: { 'x-storefront-key': 'sk_secret' } }),
      ctx('draft'),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('OPTIONS → 204 preflight', async () => {
    const { OPTIONS } = await loadSlugRoute();
    const res = await OPTIONS(
      new Request('http://x/api/storefront/v1/news/welcome', {
        method: 'OPTIONS',
        headers: { origin: 'https://demo.example', 'access-control-request-method': 'GET' },
      }),
    );
    expect(res.status).toBe(204);
  });
});
