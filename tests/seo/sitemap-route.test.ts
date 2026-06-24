import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — route handler app/sitemap.ts.
 *
 * Мокаем слой данных (настройки/строки/оверрайды модулей) — тест без БД, но
 * проверяет реальную логику роута: фильтр по ADMIK_MODULES (env ⊕ overrides),
 * домен из shop_settings.seo.site_url, исключение noindex, fallback при ошибке БД.
 */

const mocks = vi.hoisted(() => ({
  effective: vi.fn(),
  effectiveModules: vi.fn(),
  getSetting: vi.fn(),
  parseSettingValue: vi.fn(() => ({})),
  getSitemapRows: vi.fn(),
}));

vi.mock('@/lib/config/settings', () => ({
  getEffectiveSettings: mocks.effective,
  getEffectiveModules: mocks.effectiveModules,
}));
vi.mock('@/lib/settings/repository', () => ({ getSetting: mocks.getSetting }));
vi.mock('@/lib/settings/schemas', () => ({ parseSettingValue: mocks.parseSettingValue }));
vi.mock('@/lib/seo/repository', () => ({ getSitemapRows: mocks.getSitemapRows }));

const ROWS = {
  products: [
    { slug: 'p1', noindex: false },
    { slug: 'p-hidden', noindex: true },
  ],
  categories: [{ slug: 'c1', noindex: false }],
  brands: [{ slug: 'b1', noindex: false }],
  pages: [{ slug: 'about', noindex: false }],
};

beforeEach(() => {
  mocks.effective.mockResolvedValue({
    seo: { site_url: 'https://shop.example', noindex_site: false },
    modules: { overrides: {} },
  });
  mocks.getSetting.mockResolvedValue({ value: {} });
  mocks.getSitemapRows.mockResolvedValue(ROWS);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('app/sitemap — наполнение и фильтр по модулям', () => {
  it('catalog+cms включены → товары/категории/бренды/страницы в карте', async () => {
    mocks.effectiveModules.mockReturnValue(['catalog', 'cms']);
    const { default: sitemap } = await import('@/app/sitemap');
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://shop.example');
    expect(urls).toContain('https://shop.example/product/p1');
    expect(urls).toContain('https://shop.example/category/c1');
    expect(urls).toContain('https://shop.example/brand/b1');
    expect(urls).toContain('https://shop.example/about');
  });

  it('catalog выключен → без товаров (фильтр по ADMIK_MODULES)', async () => {
    mocks.effectiveModules.mockReturnValue(['cms']);
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.some((u) => u.includes('/product/'))).toBe(false);
    expect(urls).toContain('https://shop.example/about');
  });

  it('noindex исключается', async () => {
    mocks.effectiveModules.mockReturnValue(['catalog']);
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).not.toContain('https://shop.example/product/p-hidden');
  });
});

// ---------------------------------------------------------------------------
// Баг #6: noindex_site не применялся к /sitemap.xml — на staging полный список
// URL отдавался даже при заблокированном сайте. После фикса при noindex_site=true
// карта зеркалит robots (закрытый сайт) — только корень.
// ---------------------------------------------------------------------------

describe('app/sitemap — noindex_site (баг #6)', () => {
  it('noindex_site=true → карта отдаёт только корень', async () => {
    mocks.effective.mockResolvedValue({
      seo: { site_url: 'https://shop.example', noindex_site: true },
      modules: { overrides: {} },
    });
    mocks.effectiveModules.mockReturnValue(['catalog', 'cms']);
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual(['https://shop.example']);
    expect(urls.some((u) => u.includes('/product/'))).toBe(false);
    expect(urls.some((u) => u.includes('/about'))).toBe(false);
  });

  it('noindex_site=false → полный список (товары/страницы присутствуют)', async () => {
    mocks.effective.mockResolvedValue({
      seo: { site_url: 'https://shop.example', noindex_site: false },
      modules: { overrides: {} },
    });
    mocks.effectiveModules.mockReturnValue(['catalog', 'cms']);
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain('https://shop.example/product/p1');
    expect(urls).toContain('https://shop.example/about');
  });

  it('C9-1: module_overrides берётся из мемо-снимка (settings.modules.overrides), без отдельного getSetting', async () => {
    mocks.effective.mockResolvedValue({
      seo: { site_url: 'https://shop.example', noindex_site: false },
      modules: { overrides: { catalog: false } },
    });
    mocks.effectiveModules.mockReturnValue(['cms']);
    const { default: sitemap } = await import('@/app/sitemap');
    await sitemap();
    // getEffectiveModules получил ИМЕННО мемо-overrides (один снимок на запрос).
    expect(mocks.effectiveModules).toHaveBeenCalledWith(
      expect.anything(),
      { catalog: false },
    );
    // Отдельного свежего чтения module_overrides больше нет (рассинхрон закрыт).
    expect(mocks.getSetting).not.toHaveBeenCalled();
  });
});

describe('app/sitemap — fallback при ошибке БД', () => {
  it('ошибка getSitemapRows → только корень из site_url', async () => {
    mocks.effectiveModules.mockReturnValue(['catalog']);
    mocks.getSitemapRows.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual(['https://shop.example']);
    errSpy.mockRestore();
  });
});
