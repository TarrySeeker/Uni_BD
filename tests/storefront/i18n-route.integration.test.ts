import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Интеграция read-path i18n на уровне РОУТА (без БД): runStorefront резолвит
 * ctx.locale (?locale → Accept-Language → default), а РЕАЛЬНЫЙ toProductDetailDto
 * локализует значения. Репозиторий/настройки/хранилище/SEO мокаются.
 *
 * Матрица: ?locale=en → en; ?locale=xx (невалид) → default(ru); Accept-Language:fr
 * без перевода → ru-fallback; без locale → ru. Плюс Vary: Accept-Language в ответе.
 */

const KEY = 'sk_secret';
const ORIGINAL = { ...process.env };

const PRODUCT = {
  id: 'p1',
  sku: 'SKU1',
  slug: 'scarf',
  name: 'Шёлковый платок',
  description: '<p>ru</p>',
  status: 'active',
  basePrice: '1000.00',
  compareAtPrice: null,
  isFeatured: false,
  isNew: null,
  brandId: null,
  attributesCache: {},
  seoTitle: null,
  seoDescription: null,
  ogTitle: null,
  ogDescription: null,
  ogImageKey: null,
  canonicalUrl: null,
  noindex: false,
  weightG: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  translations: { en: { name: 'Silk scarf' } },
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
  categories: [],
  variants: [],
  attributes: [],
  media: [],
  inventory: [],
  brand: null,
};

vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: vi.fn(async () => true),
  getEffectiveSettings: vi.fn(async () => ({ catalog: { newProductDays: 30 } })),
}));

vi.mock('@/lib/catalog/repository', () => ({
  getProductById: vi.fn(async () => PRODUCT),
}));

vi.mock('@/lib/storefront/queries', () => ({
  getActiveProductIdBySlug: vi.fn(async () => 'p1'),
  getProductCategorySlugs: vi.fn(async () => []),
}));

// Карточка товара теперь тянет структурные секции (§9) — мокаем пустым списком,
// чтобы роут не обращался к БД в этом i18n-тесте (блоки локализуются отдельно).
vi.mock('@/lib/product-blocks', () => ({
  listBlocksByProduct: vi.fn(async () => []),
}));

vi.mock('@/lib/storefront/seo-ctx', () => ({
  buildEntitySeoCtx: vi.fn(() => ({
    siteUrl: 'https://shop.test',
    titleTemplate: '%s',
    siteName: 'Shop',
    defaultDescription: null,
    defaultOgImageKey: null,
    publicUrl: (k: string) => `https://cdn.test/${k}`,
    pathPrefix: 'product',
  })),
}));

vi.mock('@/lib/storage', () => ({
  getStorage: () => ({ url: (k: string) => `https://cdn.test/${k}` }),
}));

// getLocaleConfig() читает shop_settings.i18n через этот репозиторий — отдаём
// детерминированную конфигурацию (ru default, [ru,en,fr]) вместо DB.
vi.mock('@/lib/settings/repository', () => ({
  getSetting: vi.fn(async () => ({
    value: { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] },
  })),
}));

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/storefront/v1/products/[slug]/route');
}

async function get(query: string, headers: Record<string, string> = {}) {
  const { GET } = await loadRoute();
  const req = new Request(`http://x/api/storefront/v1/products/scarf${query}`, {
    headers: { 'x-storefront-key': KEY, ...headers },
  });
  const res = await GET(req, { params: Promise.resolve({ slug: 'scarf' }) });
  const body = await res.json().catch(() => undefined);
  return { res, body };
}

describe('storefront /products/[slug] — read-path i18n (роут+DTO, без БД)', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog';
    process.env.STOREFRONT_API_KEYS = KEY;
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  it('?locale=en → name локализован (en)', async () => {
    const { res, body } = await get('?locale=en');
    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Silk scarf');
    // Vary сообщает кешам о зависимости от языка запроса.
    expect(res.headers.get('Vary') ?? '').toContain('Accept-Language');
  });

  it('?locale=xx (невалидный) → default(ru), без 400', async () => {
    const { res, body } = await get('?locale=xx');
    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Шёлковый платок');
  });

  it('Accept-Language: en (без ?locale) → en', async () => {
    const { body } = await get('', { 'accept-language': 'en-US,en;q=0.9' });
    expect(body.data.name).toBe('Silk scarf');
  });

  it('Accept-Language: fr без перевода → ru-fallback', async () => {
    const { body } = await get('', { 'accept-language': 'fr-FR,fr;q=0.9' });
    expect(body.data.name).toBe('Шёлковый платок');
  });

  it('без locale → ru-база (текущее поведение сохранено)', async () => {
    const { body } = await get('');
    expect(body.data.name).toBe('Шёлковый платок');
  });
});
