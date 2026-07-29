import { describe, it, expect } from 'vitest';

/**
 * Дефект A-2 (аудит витрины): `GET /robots.txt` и `GET /sitemap.xml` на витрине
 * отдавали HTML ГЛАВНОЙ страницы со статусом 200 — в `storefront/app/` не было ни
 * `robots.ts`, ни `sitemap.ts`, поэтому catch-all сегмент `[lang]` перехватывал оба
 * пути (`/robots.txt` матчился как локаль `robots.txt`). Поисковик получал
 * «robots.txt» из 112 КБ HTML: директивы не читались, sitemap не публиковался.
 *
 * Здесь проверяется ЧИСТАЯ логика (storefront/lib/sitemap.ts), а не файлы-обёртки
 * `app/robots.ts` / `app/sitemap.ts`: в них по соглашению Next нет ничего, кроме
 * вызова этих функций, зато они дёргают сеть и требуют рантайма Next. Импорт —
 * относительным путём: storefront это отдельное Next-приложение со своим алиасом @
 * (алиас vitest ведёт в корень админки), см. tests/storefront/i18n-routing.test.ts.
 */

import {
  buildRobots,
  buildSitemap,
  sitemapBaseUrl,
  PRIVATE_PATHS,
  SITEMAP_PRODUCT_CAP,
} from '../../storefront/lib/sitemap';
import type { CategoryDto, PageListItemDto } from '../../storefront/lib/types';

/** Минимальные настройки магазина с заданным публичным адресом. */
function settingsWith(siteUrl: string | null | undefined, locales?: string[]) {
  return {
    seo: { siteUrl },
    ...(locales ? { i18n: { locales } } : {}),
  } as never;
}

/** Категория дерева (API отдаёт корень `catalog`, его дети — верхний уровень). */
function cat(slug: string, children: CategoryDto[] = []): CategoryDto {
  return { slug, name: slug, description: '', imageUrl: null, children };
}

const TREE: CategoryDto[] = [
  cat('catalog', [cat('twilly', [cat('twilly-small')])]),
  cat('certificates'),
];

const PAGES: PageListItemDto[] = [
  { slug: 'about', title: 'О нас', meta: { title: null, description: null } },
  {
    slug: 'secret',
    title: 'Скрытая',
    meta: { title: null, description: null, noindex: true },
  },
];

// =============================================================================
// База URL — мультитенантность
// =============================================================================

describe('sitemapBaseUrl — база абсолютных URL', () => {
  it('берёт публичный адрес магазина из его настроек (seo.siteUrl)', () => {
    expect(sitemapBaseUrl(settingsWith('https://shop.example'))).toBe(
      'https://shop.example',
    );
  });

  it('срезает хвостовой слэш, чтобы склейка не дала двойной', () => {
    expect(sitemapBaseUrl(settingsWith('https://shop.example/'))).toBe(
      'https://shop.example',
    );
  });

  it('нет настроек / пустой siteUrl → фолбэк на env, а не хардкод магазина', () => {
    expect(sitemapBaseUrl(null, 'https://from-env.example')).toBe(
      'https://from-env.example',
    );
    expect(sitemapBaseUrl(settingsWith(null), 'https://from-env.example')).toBe(
      'https://from-env.example',
    );
  });

  it('отвергает не-http(s) схему (значение уезжает в href/Sitemap)', () => {
    expect(sitemapBaseUrl(settingsWith('javascript:alert(1)'), undefined)).toBeNull();
  });

  it('нет ни настроек, ни env → null (карту строить не из чего)', () => {
    expect(sitemapBaseUrl(null, undefined)).toBeNull();
  });
});

// =============================================================================
// robots.txt
// =============================================================================

describe('buildRobots — директивы индексации', () => {
  it('разрешает индексацию корня', () => {
    const robots = buildRobots('https://shop.example');
    const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    expect(rule.allow).toBe('/');
  });

  it('закрывает служебные пути (корзина, заказ, избранное, поиск, api)', () => {
    const robots = buildRobots('https://shop.example');
    const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    const disallow = rule.disallow as string[];
    for (const path of ['/cart', '/order', '/favorite', '/search', '/api']) {
      expect(disallow).toContain(path);
    }
  });

  it('служебные пути закрыты и в локалевых префиксах (/en/cart, /fr/cart)', () => {
    const robots = buildRobots('https://shop.example');
    const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    const disallow = rule.disallow as string[];
    expect(disallow).toContain('/en/cart');
    expect(disallow).toContain('/fr/cart');
  });

  it('указывает абсолютный адрес карты сайта', () => {
    const robots = buildRobots('https://shop.example');
    expect(robots.sitemap).toBe('https://shop.example/sitemap.xml');
  });

  it('без базы URL — Sitemap не указывается (относительный адрес невалиден)', () => {
    const robots = buildRobots(null);
    expect(robots.sitemap).toBeUndefined();
  });

  it('база не хардкодится: домен другого магазина попадает как есть', () => {
    expect(buildRobots('https://another-shop.ru').sitemap).toBe(
      'https://another-shop.ru/sitemap.xml',
    );
  });

  it('PRIVATE_PATHS — единый источник служебных путей', () => {
    expect(PRIVATE_PATHS).toEqual(
      expect.arrayContaining(['/cart', '/order', '/favorite', '/search', '/api']),
    );
  });
});

// =============================================================================
// sitemap.xml
// =============================================================================

describe('buildSitemap — состав карты', () => {
  const input = {
    base: 'https://shop.example',
    locales: ['ru', 'en', 'fr'] as const,
    categories: TREE,
    products: [{ slug: 'p1' }, { slug: 'p2' }],
    designers: [{ slug: 'd1' }],
    pages: PAGES,
  };

  it('главная — ru БЕЗ префикса локали', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    expect(urls).toContain('https://shop.example/');
  });

  it('каталог, категории, товары, дизайнеры и CMS-страницы попадают в карту', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    expect(urls).toContain('https://shop.example/catalog');
    expect(urls).toContain('https://shop.example/catalog/twilly');
    expect(urls).toContain('https://shop.example/product/p1');
    expect(urls).toContain('https://shop.example/designers/d1');
    expect(urls).toContain('https://shop.example/about');
  });

  it('категории идут КАНОНИЧЕСКИМ вложенным путём (иначе редирект/дубль)', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    // twilly-small — потомок twilly: путь строится по цепочке предков.
    expect(urls).toContain('https://shop.example/catalog/twilly/twilly-small');
    expect(urls).not.toContain('https://shop.example/catalog/twilly-small');
  });

  it('технический корень `catalog` не дублируется отдельной категорией', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    expect(urls.filter((u) => u === 'https://shop.example/catalog')).toHaveLength(1);
  });

  it('страницы с noindex в карту НЕ попадают', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    expect(urls).not.toContain('https://shop.example/secret');
  });

  it('служебные пути (корзина/заказ/избранное/поиск) в карту НЕ попадают', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    for (const p of ['/cart', '/order', '/favorite', '/search']) {
      expect(urls.some((u) => u.includes(p))).toBe(false);
    }
  });

  it('URL уникальны — дублей в карте нет', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('все URL абсолютные и на домене магазина', () => {
    for (const e of buildSitemap(input)) {
      expect(e.url.startsWith('https://shop.example/')).toBe(true);
    }
  });
});

// =============================================================================
// Мультиязычность: hreflang
// =============================================================================

describe('buildSitemap — мультиязычность (hreflang)', () => {
  const input = {
    base: 'https://shop.example',
    locales: ['ru', 'en', 'fr'] as const,
    categories: TREE,
    products: [{ slug: 'p1' }],
    designers: [],
    pages: [],
  };

  it('en/fr — с префиксом, ru — без; каждая локаль своей записью', () => {
    const urls = buildSitemap(input).map((e) => e.url);
    expect(urls).toContain('https://shop.example/catalog');
    expect(urls).toContain('https://shop.example/en/catalog');
    expect(urls).toContain('https://shop.example/fr/catalog');
  });

  it('у каждой записи есть alternates.languages со всеми локалями', () => {
    const entry = buildSitemap(input).find(
      (e) => e.url === 'https://shop.example/en/catalog',
    );
    expect(entry?.alternates?.languages).toEqual({
      ru: 'https://shop.example/catalog',
      en: 'https://shop.example/en/catalog',
      fr: 'https://shop.example/fr/catalog',
    });
  });

  it('выключенный в админке язык не попадает ни в URL, ни в hreflang', () => {
    const entries = buildSitemap({ ...input, locales: ['ru', 'en'] as const });
    const urls = entries.map((e) => e.url);
    expect(urls).not.toContain('https://shop.example/fr/catalog');
    for (const e of entries) {
      expect(Object.keys(e.alternates?.languages ?? {})).not.toContain('fr');
    }
  });

  it('товар получает hreflang-связку всех локалей', () => {
    const entry = buildSitemap(input).find(
      (e) => e.url === 'https://shop.example/product/p1',
    );
    expect(entry?.alternates?.languages?.en).toBe(
      'https://shop.example/en/product/p1',
    );
  });
});

// =============================================================================
// Размер каталога и деградация
// =============================================================================

describe('buildSitemap — устойчивость и предел', () => {
  const base = 'https://shop.example';

  it('без базы URL карта пустая (относительные URL в sitemap невалидны)', () => {
    expect(
      buildSitemap({
        base: null,
        locales: ['ru'] as const,
        categories: TREE,
        products: [{ slug: 'p1' }],
        designers: [],
        pages: [],
      }),
    ).toEqual([]);
  });

  it('пустые данные (API упал) → карта всё равно содержит главную и каталог', () => {
    const urls = buildSitemap({
      base,
      locales: ['ru'] as const,
      categories: [],
      products: [],
      designers: [],
      pages: [],
    }).map((e) => e.url);
    expect(urls).toContain('https://shop.example/');
    expect(urls).toContain('https://shop.example/catalog');
  });

  it('число товаров ограничено потолком (защита от неподъёмной карты)', () => {
    const many = Array.from({ length: SITEMAP_PRODUCT_CAP + 500 }, (_, i) => ({
      slug: `p${i}`,
    }));
    const urls = buildSitemap({
      base,
      locales: ['ru'] as const,
      categories: [],
      products: many,
      designers: [],
      pages: [],
    }).map((e) => e.url);
    const productUrls = urls.filter((u) => u.includes('/product/'));
    expect(productUrls).toHaveLength(SITEMAP_PRODUCT_CAP);
  });

  it('карта не превышает лимит протокола в 50 000 URL', () => {
    const many = Array.from({ length: SITEMAP_PRODUCT_CAP }, (_, i) => ({
      slug: `p${i}`,
    }));
    const entries = buildSitemap({
      base,
      locales: ['ru', 'en', 'fr'] as const,
      categories: TREE,
      products: many,
      designers: [],
      pages: PAGES,
    });
    expect(entries.length).toBeLessThanOrEqual(50000);
  });

  it('мусорные slug (пустые/не строки) отбрасываются, а не ломают карту', () => {
    const urls = buildSitemap({
      base,
      locales: ['ru'] as const,
      categories: [],
      products: [{ slug: '' }, { slug: '  ' }, { slug: 'ok' }],
      designers: [],
      pages: [],
    }).map((e) => e.url);
    expect(urls).toContain('https://shop.example/product/ok');
    expect(urls.filter((u) => u.includes('/product/'))).toHaveLength(1);
  });
});
