import { describe, expect, it } from 'vitest';

import {
  categoryHref,
  findCategoryPath,
} from '../../storefront/lib/tree';
import type { CategoryDto } from '../../storefront/lib/types';

// ЮНИТ: построение URL категории 1:1 с боевым carrerusse.com.
//
// На проде URL категории — денормализованный `thread.url`, собранный из цепочки
// предков (Thread::updateTree), напр. /catalog/platki-i-sharfi/bandani. Витрина
// обязана строить такой же вложенный путь из дерева /categories, а не плоский
// /catalog/bandani.
//
// Дерево (как в Admik: корень `catalog` + корень-лист `certificates`):
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

describe('categoryHref — вложенные URL как на проде', () => {
  it('корень catalog → /catalog (индекс каталога)', () => {
    expect(categoryHref(tree, 'catalog')).toBe('/catalog');
  });

  it('категория lvl=1 → /catalog/{slug}', () => {
    expect(categoryHref(tree, 'platki-i-sharfi')).toBe('/catalog/platki-i-sharfi');
    expect(categoryHref(tree, 'twilly')).toBe('/catalog/twilly');
  });

  it('подкатегория lvl=2 → путь с родителем (главное отличие от прода)', () => {
    expect(categoryHref(tree, 'bandani')).toBe('/catalog/platki-i-sharfi/bandani');
    expect(categoryHref(tree, 'twilly-micro')).toBe('/catalog/twilly/twilly-micro');
  });

  it('корень-лист вне catalog → /catalog/{slug} без префикса чужого корня', () => {
    expect(categoryHref(tree, 'certificates')).toBe('/catalog/certificates');
  });

  it('неизвестный slug → /catalog/{slug} (безопасный фолбэк, без падения)', () => {
    expect(categoryHref(tree, 'no-such-cat')).toBe('/catalog/no-such-cat');
  });

  it('согласован с findCategoryPath: путь строится из цепочки предков', () => {
    const path = findCategoryPath(tree, 'bandani').map((c) => c.slug);
    expect(path).toEqual(['catalog', 'platki-i-sharfi', 'bandani']);
  });
});
