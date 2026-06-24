import { describe, it, expect } from 'vitest';

import { buildRobots, type RobotsCtx } from '@/lib/seo/robots';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — чистый билдер buildRobots.
 *
 * prod → Allow / + Disallow /admin,/api (кроме /api/storefront); non-prod
 * (NODE_ENV!=='production' ИЛИ seo.noindex_site) → Disallow /; строка Sitemap с
 * доменом из настроек; robots_extra дописывается. Без чтения env/БД внутри.
 */

const PROD: RobotsCtx = {
  nodeEnv: 'production',
  siteUrl: 'https://shop.example',
  noindexSite: false,
  robotsExtra: null,
};

describe('seo/robots — production', () => {
  it('prod → Allow /, Disallow /admin и /api', () => {
    const r = buildRobots(PROD);
    const allow = r.rules.flatMap((x) => (Array.isArray(x.allow) ? x.allow : x.allow ? [x.allow] : []));
    const disallow = r.rules.flatMap((x) =>
      Array.isArray(x.disallow) ? x.disallow : x.disallow ? [x.disallow] : [],
    );
    expect(allow).toContain('/');
    expect(disallow).toContain('/admin');
    expect(disallow).toContain('/api/');
  });

  it('prod → /api/storefront разрешён (исключение из Disallow /api)', () => {
    const r = buildRobots(PROD);
    const allow = r.rules.flatMap((x) => (Array.isArray(x.allow) ? x.allow : x.allow ? [x.allow] : []));
    expect(allow).toContain('/api/storefront');
  });

  it('prod → строка Sitemap с доменом из настроек', () => {
    const r = buildRobots(PROD);
    expect(r.sitemap).toBe('https://shop.example/sitemap.xml');
  });
});

describe('seo/robots — non-prod / noindex_site', () => {
  it('NODE_ENV=test → Disallow /', () => {
    const r = buildRobots({ ...PROD, nodeEnv: 'test' });
    const disallow = r.rules.flatMap((x) =>
      Array.isArray(x.disallow) ? x.disallow : x.disallow ? [x.disallow] : [],
    );
    expect(disallow).toContain('/');
    const allow = r.rules.flatMap((x) => (Array.isArray(x.allow) ? x.allow : x.allow ? [x.allow] : []));
    expect(allow).not.toContain('/');
  });

  it('prod + noindex_site=true → Disallow / (защита staging)', () => {
    const r = buildRobots({ ...PROD, noindexSite: true });
    const disallow = r.rules.flatMap((x) =>
      Array.isArray(x.disallow) ? x.disallow : x.disallow ? [x.disallow] : [],
    );
    expect(disallow).toContain('/');
  });
});

describe('seo/robots — robots_extra и домен', () => {
  it('robots_extra дописывается в результат', () => {
    const r = buildRobots({ ...PROD, robotsExtra: 'Crawl-delay: 10' });
    expect(r.extra).toBe('Crawl-delay: 10');
  });

  it('sitemap-домен берётся из site_url (не хардкод)', () => {
    const r = buildRobots({ ...PROD, siteUrl: 'https://other.test' });
    expect(r.sitemap).toBe('https://other.test/sitemap.xml');
  });

  it('без site_url → sitemap undefined (нет хардкода домена)', () => {
    const r = buildRobots({ ...PROD, siteUrl: null });
    expect(r.sitemap).toBeUndefined();
  });
});
