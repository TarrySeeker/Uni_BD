import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — route handler app/robots.ts.
 *
 * Мокаем настройки — тест без БД. Проверяет: домен Sitemap из shop_settings;
 * NODE_ENV=test → Disallow / (защита non-prod); fallback при ошибке настроек →
 * закрытый сайт.
 */

const mocks = vi.hoisted(() => ({ effective: vi.fn() }));

vi.mock('@/lib/config/settings', () => ({ getEffectiveSettings: mocks.effective }));

beforeEach(() => {
  mocks.effective.mockResolvedValue({
    seo: { site_url: 'https://shop.example', noindex_site: false, robots_extra: null },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function bodyText(res: Response): Promise<string> {
  return await res.text();
}

describe('app/robots — NODE_ENV=test (non-prod)', () => {
  it('NODE_ENV=test → Disallow / (закрыт)', async () => {
    // vitest выставляет NODE_ENV=test по умолчанию.
    const { GET } = await import('@/app/robots.txt/route');
    const text = await bodyText(await GET());
    expect(text).toContain('Disallow: /');
  });

  it('домен Sitemap берётся из shop_settings.seo.site_url', async () => {
    const { GET } = await import('@/app/robots.txt/route');
    const text = await bodyText(await GET());
    expect(text).toContain('Sitemap: https://shop.example/sitemap.xml');
  });
});

describe('app/robots — fallback', () => {
  it('ошибка настроек → закрытый сайт (Disallow /)', async () => {
    mocks.effective.mockRejectedValue(new Error('no settings'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('@/app/robots.txt/route');
    const text = await bodyText(await GET());
    expect(text).toContain('Disallow: /');
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Баг #5: robots_extra терялся при сериализации MetadataRoute.Robots. После
// фикса роут — plain-text GET Route Handler, отдающий правила + Sitemap +
// robots_extra «как есть». Тесты идут на GET() и читают фактический текст.
// ---------------------------------------------------------------------------

describe('app/robots — GET plain-text (баг #5: robots_extra)', () => {
  it('robots_extra попадает в тело /robots.txt (вместе с правилами и Sitemap)', async () => {
    mocks.effective.mockResolvedValue({
      seo: {
        site_url: 'https://shop.example',
        noindex_site: false,
        robots_extra: 'Crawl-delay: 10\nDisallow: /search',
      },
    });
    const { GET } = await import('@/app/robots.txt/route');
    const res = await GET();
    const text = await bodyText(res);
    // robots_extra строки присутствуют дословно
    expect(text).toContain('Crawl-delay: 10');
    expect(text).toContain('Disallow: /search');
    // Sitemap-строка с доменом из настроек
    expect(text).toContain('Sitemap: https://shop.example/sitemap.xml');
    // Базовые правила тоже на месте
    expect(text).toContain('User-agent: *');
    // Content-Type text/plain
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('prod → открытый каталог: Allow /, Disallow /admin и /api/', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mocks.effective.mockResolvedValue({
      seo: { site_url: 'https://shop.example', noindex_site: false, robots_extra: null },
    });
    const { GET } = await import('@/app/robots.txt/route');
    const text = await bodyText(await GET());
    expect(text).toContain('Allow: /');
    expect(text).toContain('Allow: /api/storefront');
    expect(text).toContain('Disallow: /admin');
    expect(text).toContain('Disallow: /api/');
  });

  it('noindex_site=true → блокирующее правило Disallow / в теле', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mocks.effective.mockResolvedValue({
      seo: { site_url: 'https://shop.example', noindex_site: true, robots_extra: null },
    });
    const { GET } = await import('@/app/robots.txt/route');
    const text = await bodyText(await GET());
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Disallow: /');
    // открытого каталога быть не должно
    expect(text).not.toContain('Disallow: /admin');
  });

  it('ошибка настроек → закрытый сайт в теле GET (Disallow /)', async () => {
    mocks.effective.mockRejectedValue(new Error('no settings'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('@/app/robots.txt/route');
    const text = await bodyText(await GET());
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Disallow: /');
    errSpy.mockRestore();
  });
});
