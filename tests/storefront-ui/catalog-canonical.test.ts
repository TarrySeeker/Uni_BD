import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  categoryHref,
  categoryRouteLocation,
  resolveCategoryRoute,
} from '../../storefront/lib/tree';
import type { CategoryDto } from '../../storefront/lib/types';

const STOREFRONT = resolve(__dirname, '../../storefront');
const routeSource = () =>
  readFileSync(resolve(STOREFRONT, 'app/[lang]/catalog/[...slug]/page.tsx'), 'utf8');

// ЮНИТ: канонизация URL категории в catch-all роуте /catalog/[...slug].
//
// ДЕФЕКТ (живьём на публичном стенде): роут брал ТОЛЬКО последний сегмент, предков
// не валидировал, а canonical строил из СЫРОГО пути запроса. Итог — одна категория
// доступна по бесконечному числу URL, и каждый канонизирует сам себя:
//   /catalog/certificates/twilly → 200, canonical=/catalog/certificates/twilly
//   /catalog/a/b/c/bandani       → 200, canonical=/catalog/a/b/c/bandani
// Это дубли контента в индексе. Правило: единственный валидный путь категории —
// канонический (цепочка предков, categoryHref); всё остальное → постоянный редирект
// на него, несуществующая категория → 404.
//
// Дерево — как в Admik (корень `catalog` + корень-лист `certificates`):
//   catalog
//   ├─ platki-i-sharfi
//   │  └─ bandani
//   └─ twilly
//      └─ twilly-micro
//   certificates
function cat(slug: string, children: CategoryDto[] = []): CategoryDto {
  return { slug, name: slug, description: '', imageUrl: null, children };
}

const tree: CategoryDto[] = [
  cat('catalog', [
    cat('platki-i-sharfi', [cat('bandani')]),
    cat('twilly', [cat('twilly-micro')]),
  ]),
  cat('certificates'),
];

describe('resolveCategoryRoute — канонический путь проходит без редиректа', () => {
  it('категория lvl=1 по своему пути → ok', () => {
    expect(resolveCategoryRoute(tree, ['twilly'])).toEqual({
      status: 'ok',
      slug: 'twilly',
      canonicalPath: '/catalog/twilly',
    });
  });

  it('подкатегория lvl=2 по полному пути предков → ok', () => {
    expect(resolveCategoryRoute(tree, ['platki-i-sharfi', 'bandani'])).toEqual({
      status: 'ok',
      slug: 'bandani',
      canonicalPath: '/catalog/platki-i-sharfi/bandani',
    });
  });

  it('корень вне catalog (сертификаты) → ok, чужой корень в путь не подмешивается', () => {
    expect(resolveCategoryRoute(tree, ['certificates']).status).toBe('ok');
  });

  it('хвостовые пустые сегменты (слэш в конце) не ломают канон', () => {
    expect(resolveCategoryRoute(tree, ['twilly', '']).status).toBe('ok');
  });
});

describe('resolveCategoryRoute — мусорный путь предков → редирект на канон', () => {
  it('чужой предок: /catalog/certificates/twilly → /catalog/twilly', () => {
    expect(resolveCategoryRoute(tree, ['certificates', 'twilly'])).toEqual({
      status: 'redirect',
      slug: 'twilly',
      canonicalPath: '/catalog/twilly',
    });
  });

  it('выдуманные предки: /catalog/a/b/c/bandani → /catalog/platki-i-sharfi/bandani', () => {
    expect(resolveCategoryRoute(tree, ['a', 'b', 'c', 'bandani'])).toEqual({
      status: 'redirect',
      slug: 'bandani',
      canonicalPath: '/catalog/platki-i-sharfi/bandani',
    });
  });

  it('плоский путь без предков: /catalog/bandani → /catalog/platki-i-sharfi/bandani', () => {
    const res = resolveCategoryRoute(tree, ['bandani']);
    expect(res.status).toBe('redirect');
    expect(res.canonicalPath).toBe('/catalog/platki-i-sharfi/bandani');
  });

  it('несуществующий предок при существующей категории: /catalog/zzz-junk/bandani', () => {
    const res = resolveCategoryRoute(tree, ['zzz-junk', 'bandani']);
    expect(res.status).toBe('redirect');
    expect(res.canonicalPath).toBe('/catalog/platki-i-sharfi/bandani');
  });

  it('верный предок, но не полная цепочка сверху не требуется — лишний `catalog` режется', () => {
    const res = resolveCategoryRoute(tree, ['catalog', 'platki-i-sharfi', 'bandani']);
    expect(res.status).toBe('redirect');
    expect(res.canonicalPath).toBe('/catalog/platki-i-sharfi/bandani');
  });

  it('редирект идемпотентен: цель редиректа сама уже каноническая', () => {
    const res = resolveCategoryRoute(tree, ['a', 'b', 'bandani']);
    const segments = res.canonicalPath!.replace(/^\/catalog\/?/, '').split('/').filter(Boolean);
    expect(resolveCategoryRoute(tree, segments).status).toBe('ok');
  });

  it('канон берётся из categoryHref, а не из второй реализации', () => {
    const res = resolveCategoryRoute(tree, ['junk', 'twilly-micro']);
    expect(res.canonicalPath).toBe(categoryHref(tree, 'twilly-micro'));
  });
});

describe('resolveCategoryRoute — несуществующая категория → 404', () => {
  it('неизвестный последний сегмент → not-found (а не редирект на выдумку)', () => {
    expect(resolveCategoryRoute(tree, ['no-such-cat'])).toEqual({
      status: 'not-found',
      slug: 'no-such-cat',
      canonicalPath: null,
    });
  });

  it('неизвестная категория с мусорными предками → not-found', () => {
    expect(resolveCategoryRoute(tree, ['a', 'b', 'no-such-cat']).status).toBe('not-found');
  });

  it('пустой путь → not-found', () => {
    expect(resolveCategoryRoute(tree, []).status).toBe('not-found');
    expect(resolveCategoryRoute(tree, ['']).status).toBe('not-found');
  });
});

describe('categoryRouteLocation — редирект сохраняет локаль', () => {
  const canonical = '/catalog/platki-i-sharfi/bandani';

  it('ru живёт на корне — префикса нет', () => {
    expect(categoryRouteLocation(canonical, 'ru')).toBe(canonical);
  });

  it('en/fr — префикс локали обязан сохраниться', () => {
    expect(categoryRouteLocation(canonical, 'en')).toBe('/en' + canonical);
    expect(categoryRouteLocation(canonical, 'fr')).toBe('/fr' + canonical);
  });
});

describe('categoryRouteLocation — редирект сохраняет query (пагинация/сортировка)', () => {
  const canonical = '/catalog/platki-i-sharfi/bandani';

  it('без query — «?» не появляется', () => {
    expect(categoryRouteLocation(canonical, 'ru', {})).toBe(canonical);
    expect(categoryRouteLocation(canonical, 'ru', undefined)).toBe(canonical);
  });

  it('?page и ?sort переживают редирект', () => {
    expect(categoryRouteLocation(canonical, 'ru', { page: '2', sort: 'desc' })).toBe(
      `${canonical}?page=2&sort=desc`,
    );
  });

  it('локаль и query вместе', () => {
    expect(categoryRouteLocation(canonical, 'en', { page: '3' })).toBe(
      `/en${canonical}?page=3`,
    );
  });

  it('undefined-значения выбрасываются, повторяющиеся ключи сохраняются', () => {
    expect(categoryRouteLocation(canonical, 'ru', { page: undefined, sort: 'asc' })).toBe(
      `${canonical}?sort=asc`,
    );
    expect(categoryRouteLocation(canonical, 'ru', { tag: ['a', 'b'] })).toBe(
      `${canonical}?tag=a&tag=b`,
    );
  });

  it('значения экранируются (никакой инъекции в Location)', () => {
    expect(categoryRouteLocation(canonical, 'ru', { sort: 'a b&c' })).toBe(
      `${canonical}?sort=a+b%26c`,
    );
  });
});

// GUARD: юниты выше проверяют чистые функции, но не то, что РОУТ их использует.
// Без этого блока откат page.tsx к разбору одного lastSlug оставил бы все тесты
// зелёными, а дубли URL вернулись бы на публичный сайт незамеченными.
describe('роут /catalog/[...slug] применяет канонизацию', () => {
  it('резолвит маршрут через resolveCategoryRoute, а не по одному сегменту', () => {
    const src = routeSource();
    expect(src).toContain('resolveCategoryRoute');
    expect(src).not.toMatch(/lastSlug/);
  });

  it('неканонический путь уводит постоянным редиректом на канонический', () => {
    const src = routeSource();
    expect(src).toContain('permanentRedirect');
    expect(src).toMatch(/status === 'redirect'/);
    expect(src).toContain('categoryRouteLocation');
    expect(src).toContain('route.canonicalPath');
  });

  it('несуществующая категория отдаёт 404', () => {
    const src = routeSource();
    expect(src).toMatch(/status === 'not-found'/);
    expect(src).toContain('notFound()');
  });

  it('canonical в метаданных строится из канонического пути, а не из сырого запроса', () => {
    const src = routeSource();
    expect(src).not.toMatch(/alternatesFor\(`\/catalog\/\$\{slug\.join\('\/'\)\}`\)/);
  });
});
