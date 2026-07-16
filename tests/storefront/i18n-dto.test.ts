import { describe, it, expect } from 'vitest';

/**
 * i18n read-path (инкремент 2a, ADR-i18n docs/24 §1): локализация storefront-DTO
 * по ctx.locale через jsonb-оверлей translations. Инвариант anti-tamper: ФОРМА
 * DTO НЕ меняется (те же ключи/типы) — меняются только ЗНАЧЕНИЯ переводимых полей.
 *
 * Матрица: locale=en с переводом → en; locale=fr без перевода → ru-fallback;
 * без loc → ru-база. Чисто (без БД/Next) — на доменных фикстурах с translations.
 */

import {
  toProductDetailDto,
  toProductListItemDto,
  toVariantDto,
  toFullBrandDto,
  toCategoryTreeDto,
  toCategoryDto,
} from '@/lib/storefront/dto';
import { toPublicPageDto, toPublicPageListItemDto } from '@/lib/storefront/cms-dto';
import { extractRawLocale, type LocalizeCtx } from '@/lib/storefront/locale';
import type {
  Brand,
  CategoryTreeNode,
  ProductDetail,
  ProductListRow,
  ProductVariant,
} from '@/lib/catalog/types';
import type { CmsPageWithSections } from '@/lib/cms/types';
import type { SeoCtx } from '@/lib/seo/meta';

const D = new Date('2026-06-01T00:00:00Z');
const EN: LocalizeCtx = { locale: 'en', defaultLocale: 'ru' };
const FR: LocalizeCtx = { locale: 'fr', defaultLocale: 'ru' };
const RU: LocalizeCtx = { locale: 'ru', defaultLocale: 'ru' };

const SEO: SeoCtx = {
  siteUrl: 'https://shop.test',
  titleTemplate: '%s',
  siteName: 'Shop',
  defaultDescription: null,
  defaultOgImageKey: null,
  publicUrl: (k: string) => `https://cdn.test/${k}`,
  pathPrefix: 'product',
};

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: 'p1',
    sku: 'SKU1',
    slug: 'scarf',
    name: 'Шёлковый платок',
    description: '<p>Русское описание</p>',
    status: 'active',
    basePrice: '1000.00',
    compareAtPrice: null,
    isFeatured: false,
    isNew: null,
    brandId: null,
    designerId: null,
    attributesCache: {},
    colors: [],
    seoTitle: 'СЕО РУ',
    seoDescription: 'СЕО описание',
    ogTitle: null,
    ogDescription: null,
    ogImageKey: null,
    canonicalUrl: null,
    noindex: false,
    weightG: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    translations: {
      en: {
        name: 'Silk scarf',
        description: '<p>English description</p>',
        seoTitle: 'SEO EN',
      },
    },
    createdAt: D,
    updatedAt: D,
    categories: [],
    variants: [],
    attributes: [],
    media: [],
    inventory: [],
    brand: null,
    designer: null,
    ...over,
  };
}

describe('i18n storefront-DTO — товар (детальная карточка)', () => {
  it('locale=en с переводом → en-значения name/description/seoTitle', () => {
    const dto = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
      loc: EN,
    });
    expect(dto.name).toBe('Silk scarf');
    expect(dto.description).toBe('<p>English description</p>');
    // SEO-мета строится из локализованного объекта → seoTitle en.
    expect(dto.meta.title).toBe('SEO EN');
  });

  it('locale=fr без перевода → ru-fallback (никогда не пусто)', () => {
    const dto = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
      loc: FR,
    });
    expect(dto.name).toBe('Шёлковый платок');
    expect(dto.description).toBe('<p>Русское описание</p>');
  });

  it('без loc / loc=ru → базовые (ru) значения; форма DTO идентична', () => {
    const base = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
    });
    const ru = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
      loc: RU,
    });
    expect(base.name).toBe('Шёлковый платок');
    // Anti-tamper: ключи DTO для en и ru совпадают (меняются только значения).
    const en = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
      loc: EN,
    });
    expect(Object.keys(en).sort()).toEqual(Object.keys(base).sort());
    expect(ru).toEqual(base);
  });

  it('вариант локализуется по своему оверлею (whitelist=name)', () => {
    const variant: ProductVariant = {
      id: 'v1',
      productId: 'p1',
      sku: 'V-SKU',
      name: 'Красный',
      priceOverride: null,
      priceDelta: '0',
      compareAtPrice: null,
      isActive: true,
      sort: 0,
      attributesCache: {},
      weightG: null,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      translations: { en: { name: 'Red' } },
      createdAt: D,
      updatedAt: D,
    };
    expect(toVariantDto(variant, product(), EN).name).toBe('Red');
    expect(toVariantDto(variant, product(), FR).name).toBe('Красный');
    expect(toVariantDto(variant, product()).name).toBe('Красный');
  });
});

describe('i18n storefront-DTO — список товаров', () => {
  function row(): ProductListRow {
    return {
      id: 'p1',
      sku: 'SKU1',
      slug: 'scarf',
      name: 'Шёлковый платок',
      status: 'active',
      basePrice: '1000.00',
      compareAtPrice: null,
      discountPct: null,
      onSale: false,
      isFeatured: false,
      effectiveIsNew: false,
      brand: null,
      totalStock: 5,
      availableStock: 5,
      primaryMediaUrl: null,
      translations: { en: { name: 'Silk scarf' } },
      createdAt: D,
    };
  }
  it('locale=en → name en; fr/none → ru', () => {
    expect(toProductListItemDto(row(), undefined, EN).name).toBe('Silk scarf');
    expect(toProductListItemDto(row(), undefined, FR).name).toBe('Шёлковый платок');
    expect(toProductListItemDto(row()).name).toBe('Шёлковый платок');
  });
});

describe('i18n storefront-DTO — бренд', () => {
  function brand(): Brand {
    return {
      id: 'b1',
      slug: 'atlas',
      name: 'Атлас',
      description: 'Русский бренд',
      logoKey: null,
      isActive: true,
      sort: 0,
      externalUrl: null,
      seoTitle: null,
      seoDescription: null,
      ogTitle: null,
      ogDescription: null,
      ogImageKey: null,
      canonicalUrl: null,
      noindex: false,
      translations: { en: { name: 'Atlas', description: 'English brand' } },
      createdAt: D,
      updatedAt: D,
    };
  }
  it('locale=en → name/description en; fr → ru-fallback', () => {
    const en = toFullBrandDto(brand(), { seoCtx: SEO, loc: EN });
    expect(en.name).toBe('Atlas');
    expect(en.description).toBe('English brand');
    const fr = toFullBrandDto(brand(), { seoCtx: SEO, loc: FR });
    expect(fr.name).toBe('Атлас');
    expect(fr.description).toBe('Русский бренд');
  });
});

describe('i18n storefront-DTO — категории (дерево + узел)', () => {
  function node(): CategoryTreeNode {
    return {
      id: 'c1',
      parentId: null,
      slug: 'scarves',
      name: 'Платки',
      description: 'Русское',
      sort: 0,
      isActive: true,
      imageKey: null,
      seoTitle: null,
      seoDescription: null,
      ogTitle: null,
      ogDescription: null,
      ogImageKey: null,
      canonicalUrl: null,
      noindex: false,
      translations: { en: { name: 'Scarves', description: 'English' } },
      createdAt: D,
      updatedAt: D,
      children: [
        {
          id: 'c2',
          parentId: 'c1',
          slug: 'silk',
          name: 'Шёлк',
          description: '',
          sort: 0,
          isActive: true,
          imageKey: null,
          seoTitle: null,
          seoDescription: null,
          ogTitle: null,
          ogDescription: null,
          ogImageKey: null,
          canonicalUrl: null,
          noindex: false,
          translations: { en: { name: 'Silk' } },
          createdAt: D,
          updatedAt: D,
          children: [],
        },
      ],
    };
  }
  it('дерево: en локализует узел и детей рекурсивно; fr → ru', () => {
    const en = toCategoryTreeDto([node()], EN);
    expect(en[0]!.name).toBe('Scarves');
    expect(en[0]!.children[0]!.name).toBe('Silk');
    const ru = toCategoryTreeDto([node()]);
    expect(ru[0]!.name).toBe('Платки');
    expect(ru[0]!.children[0]!.name).toBe('Шёлк');
  });
  it('узел с seoCtx: en локализует name/description + meta', () => {
    const en = toCategoryDto(node(), { seoCtx: SEO, loc: EN });
    expect(en.name).toBe('Scarves');
    expect(en.description).toBe('English');
    expect(en.meta?.title).toBe('Scarves');
  });
});

describe('i18n storefront-DTO — CMS-страница + секции', () => {
  function page(): CmsPageWithSections {
    return {
      id: 'pg1',
      slug: 'about',
      title: 'О нас',
      status: 'published',
      publishedAt: D,
      seoTitle: null,
      seoDescription: null,
      ogTitle: null,
      ogDescription: null,
      ogImageUrl: null,
      canonicalUrl: null,
      noindex: false,
      sitemapPriority: null,
      sitemapChangefreq: null,
      translations: { en: { title: 'About us' } },
      createdBy: null,
      updatedBy: null,
      createdAt: D,
      updatedAt: D,
      sections: [
        {
          id: 's1',
          pageId: 'pg1',
          sectionKey: 'hero',
          type: 'hero',
          content: { title: 'Привет', subtitle: 'Подзаголовок' },
          translations: { en: { title: 'Hello' } },
          displayOrder: 0,
          enabled: true,
          createdAt: D,
          updatedAt: D,
        },
      ],
    };
  }
  it('locale=en → title en; секция deep-merge (title en, subtitle из базы)', () => {
    const en = toPublicPageDto(page(), SEO, SEO.publicUrl, EN);
    expect(en.title).toBe('About us');
    expect(en.sections[0]!.content).toEqual({
      title: 'Hello',
      subtitle: 'Подзаголовок',
    });
  });
  it('locale=fr без перевода → ru-база (title и контент секции)', () => {
    const fr = toPublicPageDto(page(), SEO, SEO.publicUrl, FR);
    expect(fr.title).toBe('О нас');
    expect(fr.sections[0]!.content).toEqual({
      title: 'Привет',
      subtitle: 'Подзаголовок',
    });
  });
  it('список страниц: en локализует title; форма DTO неизменна', () => {
    const en = toPublicPageListItemDto(page(), SEO, EN);
    const ru = toPublicPageListItemDto(page(), SEO);
    expect(en.title).toBe('About us');
    expect(ru.title).toBe('О нас');
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
});

describe('i18n — извлечение сырого locale из запроса (?locale → Accept-Language → null)', () => {
  it('?locale= имеет приоритет над Accept-Language', () => {
    const req = new Request('http://x/?locale=fr', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    expect(extractRawLocale(req)).toBe('fr');
  });
  it('без ?locale → первый тег Accept-Language', () => {
    const req = new Request('http://x/', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    expect(extractRawLocale(req)).toBe('en-US');
  });
  it('нет ни ?locale, ни Accept-Language → null (резолвер отдаст default)', () => {
    expect(extractRawLocale(new Request('http://x/'))).toBeNull();
  });
});
