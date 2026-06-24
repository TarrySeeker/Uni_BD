import { describe, expect, it } from 'vitest';

import * as cmsSlug from '@/lib/cms/slug';
import * as catalogSlug from '@/lib/catalog/slug';

/**
 * Тесты пакета 5.C-1 (docs/11 §5.1.6) — lib/cms/slug.
 *
 * Инвариант 5.1: slug-логика CMS ПЕРЕИСПОЛЬЗУЕТ правила каталога,
 * а не дублирует алгоритм. Проверяем тождественность поведения.
 */

describe('cms/slug — переиспользование правил каталога', () => {
  it('реэкспортирует те же функции (тождество ссылок)', () => {
    expect(cmsSlug.slugify).toBe(catalogSlug.slugify);
    expect(cmsSlug.isValidSlug).toBe(catalogSlug.isValidSlug);
    expect(cmsSlug.uniquifySlug).toBe(catalogSlug.uniquifySlug);
  });

  it('slugify транслитерирует кириллицу и нормализует', () => {
    expect(cmsSlug.slugify('О компании')).toBe('o-kompanii');
    expect(cmsSlug.slugify('  Hello   World!! ')).toBe('hello-world');
  });

  it('isValidSlug принимает корректный ЧПУ и отвергает мусор', () => {
    expect(cmsSlug.isValidSlug('about-us')).toBe(true);
    expect(cmsSlug.isValidSlug('About')).toBe(false);
    expect(cmsSlug.isValidSlug('a--b')).toBe(false);
    expect(cmsSlug.isValidSlug('-a')).toBe(false);
    expect(cmsSlug.isValidSlug('')).toBe(false);
  });

  it('uniquifySlug даёт кандидатов для ретрая на коллизии', () => {
    expect(cmsSlug.uniquifySlug('about', 0)).toBe('about');
    expect(cmsSlug.uniquifySlug('about', 1)).toBe('about-2');
    expect(cmsSlug.uniquifySlug('about', 2)).toBe('about-3');
  });
});
