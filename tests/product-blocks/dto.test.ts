import { describe, expect, it } from 'vitest';

import { toProductBlockDto, toProductDetailDto } from '@/lib/storefront/dto';
import type { LocalizeCtx } from '@/lib/storefront/locale';
import type { ProductBlock } from '@/lib/product-blocks';
import type { ProductDetail } from '@/lib/catalog/types';
import type { SeoCtx } from '@/lib/seo/meta';

const publicUrl = (k: string) => `https://cdn.test/${k}`;
const D = new Date('2026-01-01T00:00:00Z');

const TEST_SEO_CTX: SeoCtx = {
  siteUrl: 'https://shop.test',
  titleTemplate: '%s',
  siteName: 'Shop',
  defaultDescription: null,
  defaultOgImageKey: null,
  publicUrl,
  pathPrefix: 'product',
};

function block(over: Partial<ProductBlock> = {}): ProductBlock {
  return {
    id: 'bl1',
    productId: 'p1',
    type: 'quote',
    title: 'Заголовок',
    blockquot: 'Цитата',
    authorDesignerId: 'd1',
    author: { id: 'd1', slug: 'ivanov', name: 'Иванов', imageKey: 'designers/d1.webp' },
    body: null,
    imageKey: 'product-blocks/bl1/x.webp',
    tabs: [],
    sort: 0,
    translations: {},
    createdAt: D,
    ...over,
  };
}

const EN: LocalizeCtx = { locale: 'en', defaultLocale: 'ru' };
const RU: LocalizeCtx = { locale: 'ru', defaultLocale: 'ru' };

describe('storefront/dto — toProductBlockDto', () => {
  it('без loc отдаёт базовые (ru) значения; картинку резолвит в URL', () => {
    const dto = toProductBlockDto(block(), { publicUrl });
    expect(dto.title).toBe('Заголовок');
    expect(dto.blockquot).toBe('Цитата');
    expect(dto.imageUrl).toBe('https://cdn.test/product-blocks/bl1/x.webp');
    // Сырой S3-ключ наружу не отдаём.
    expect(JSON.stringify(dto)).not.toContain('imageKey');
  });

  it('автор цитаты — кросс-линк на дизайнера (slug/name/аватар-URL)', () => {
    const dto = toProductBlockDto(block(), { publicUrl });
    expect(dto.author).toEqual({
      slug: 'ivanov',
      name: 'Иванов',
      imageUrl: 'https://cdn.test/designers/d1.webp',
    });
  });

  it('без автора → author=null', () => {
    const dto = toProductBlockDto(block({ authorDesignerId: null, author: null }), { publicUrl });
    expect(dto.author).toBeNull();
  });

  it('en → берёт перевод; отсутствующее поле — фолбэк на базу (ru)', () => {
    const b = block({
      translations: { en: { title: 'Heading' } }, // blockquot без перевода
    });
    const dto = toProductBlockDto(b, { loc: EN, publicUrl });
    expect(dto.title).toBe('Heading');
    expect(dto.blockquot).toBe('Цитата'); // фолбэк на базу
  });

  it('locale === default → базовые значения (оверлей не применяется)', () => {
    const b = block({ translations: { en: { title: 'Heading' } } });
    const dto = toProductBlockDto(b, { loc: RU, publicUrl });
    expect(dto.title).toBe('Заголовок');
  });

  it('табы локализуются структурно (deep-merge по индексу)', () => {
    const b = block({
      type: 'tabs',
      tabs: [
        { name: 'Уход', text: 'Стирка' },
        { name: 'Состав', text: 'Шёлк' },
      ],
      translations: { en: { tabs: [{ name: 'Care', text: 'Wash' }] } },
    });
    const dto = toProductBlockDto(b, { loc: EN, publicUrl });
    expect(dto.tabs[0]).toEqual({ name: 'Care', text: 'Wash' });
    expect(dto.tabs[1]).toEqual({ name: 'Состав', text: 'Шёлк' }); // фолбэк
  });

  it('imageKey=null → imageUrl=null', () => {
    const dto = toProductBlockDto(block({ imageKey: null }), { publicUrl });
    expect(dto.imageUrl).toBeNull();
  });
});

describe('storefront/dto — toProductDetailDto прокидывает блоки', () => {
  const product: ProductDetail = {
    id: 'p1', sku: 'SKU1', slug: 'scarf', name: 'Scarf', description: 'nice',
    status: 'active', basePrice: '1000.00', compareAtPrice: null,
    isFeatured: false, isNew: null, brandId: null, designerId: null,
    attributesCache: {}, seoTitle: null, seoDescription: null,
    ogTitle: null, ogDescription: null, ogImageKey: null, canonicalUrl: null, noindex: false,
    weightG: null, lengthCm: null, widthCm: null, heightCm: null,
    createdAt: D, updatedAt: D,
    categories: [], variants: [], attributes: [], media: [], inventory: [],
    brand: null, designer: null,
  };

  it('blocks локализуются по ctx.locale и попадают в DTO', () => {
    const dto = toProductDetailDto(product, {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: TEST_SEO_CTX,
      loc: EN,
      blocks: [block({ type: 'text', body: 'Базовый', translations: { en: { body: 'English' } } })],
    });
    expect(dto.blocks).toHaveLength(1);
    expect(dto.blocks[0]!.body).toBe('English');
  });

  it('без blocks — пустой массив (обратная совместимость)', () => {
    const dto = toProductDetailDto(product, {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: TEST_SEO_CTX,
    });
    expect(dto.blocks).toEqual([]);
  });
});
