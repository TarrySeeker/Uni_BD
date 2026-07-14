import { describe, expect, it } from 'vitest';

import { toDesignerDto, toFullDesignerDto } from '@/lib/storefront/dto';
import type { Designer, DesignerRef } from '@/lib/designers/types';
import type { SeoCtx } from '@/lib/seo/meta';

/**
 * ЮНИТ — публичные DTO дизайнера (§9). Проверяет:
 *  - toDesignerDto (кросс-линк из товара): только slug/name/imageUrl, ключ→URL;
 *  - toFullDesignerDto (страница /designers): внутренние поля скрыты, аватар/фото
 *    страницы резолвятся через publicUrl, переводимые поля локализуются по ctx.locale.
 */

const seoCtx: SeoCtx = {
  siteUrl: 'https://shop.test',
  titleTemplate: '%s',
  siteName: 'Shop',
  defaultDescription: null,
  defaultOgImageKey: null,
  publicUrl: (k: string) => `https://cdn.test/${k}`,
  pathPrefix: 'designer',
};

const D = new Date('2026-01-01T00:00:00Z');

function designer(over: Partial<Designer> = {}): Designer {
  return {
    id: 'd1',
    slug: 'jane-doe',
    name: 'Джейн Доу',
    country: 'Россия',
    description: '<p>био</p>',
    imageKey: 'designers/avatar.webp',
    pageImageKey: 'designers/page.webp',
    videoUrl: 'https://vimeo.com/1',
    socials: { instagram: 'https://ig/jane' },
    workCount: 7,
    isActive: true,
    sort: 0,
    seoTitle: 'SEO',
    seoDescription: 'SEO d',
    ogTitle: null,
    ogDescription: null,
    ogImageKey: null,
    canonicalUrl: null,
    noindex: false,
    translations: { en: { name: 'Jane Doe', country: 'Russia' } },
    createdAt: D,
    updatedAt: D,
    ...over,
  };
}

describe('storefront/dto — дизайнер', () => {
  it('toDesignerDto: null → null', () => {
    expect(toDesignerDto(null)).toBeNull();
  });

  it('toDesignerDto: кросс-линк только slug/name/imageUrl; ключ→URL', () => {
    const ref: DesignerRef = { id: 'd1', slug: 'jane-doe', name: 'Джейн', imageKey: 'designers/a.webp' };
    const dto = toDesignerDto(ref, seoCtx.publicUrl);
    expect(dto).toEqual({
      slug: 'jane-doe',
      name: 'Джейн',
      imageUrl: 'https://cdn.test/designers/a.webp',
    });
    // Сырой ключ и внутренний id наружу не отдаются.
    expect(dto as object).not.toHaveProperty('id');
    expect(dto as object).not.toHaveProperty('imageKey');
  });

  it('toDesignerDto: без резолвера imageUrl=null (не падает)', () => {
    const ref: DesignerRef = { id: 'd1', slug: 's', name: 'n', imageKey: 'k' };
    expect(toDesignerDto(ref)!.imageUrl).toBeNull();
  });

  it('toFullDesignerDto: скрывает внутренние поля, резолвит ключи в URL', () => {
    const dto = toFullDesignerDto(designer(), { seoCtx });
    expect(dto.slug).toBe('jane-doe');
    expect(dto.imageUrl).toBe('https://cdn.test/designers/avatar.webp');
    expect(dto.pageImageUrl).toBe('https://cdn.test/designers/page.webp');
    expect(dto.workCount).toBe(7);
    expect(dto.socials).toEqual({ instagram: 'https://ig/jane' });
    expect(dto.meta).toBeDefined();
    // Внутренние поля отсутствуют.
    for (const hidden of ['id', 'sort', 'isActive', 'imageKey', 'pageImageKey', 'createdAt']) {
      expect(dto as object).not.toHaveProperty(hidden);
    }
  });

  it('toFullDesignerDto: локализация en → перевод, отсутствующее поле → база ru', () => {
    const en = toFullDesignerDto(designer(), {
      seoCtx,
      loc: { locale: 'en', defaultLocale: 'ru' },
    });
    expect(en.name).toBe('Jane Doe');
    expect(en.country).toBe('Russia');
    // description без перевода → база.
    expect(en.description).toBe('<p>био</p>');
  });

  it('toFullDesignerDto: locale=ru (default) → база без изменений', () => {
    const ru = toFullDesignerDto(designer(), {
      seoCtx,
      loc: { locale: 'ru', defaultLocale: 'ru' },
    });
    expect(ru.name).toBe('Джейн Доу');
    expect(ru.country).toBe('Россия');
  });
});
