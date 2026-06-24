import { describe, it, expect } from 'vitest';
import {
  toBrandDto,
  toFullBrandDto,
  toProductListItemDto,
  toProductDetailDto,
  toVariantDto,
  toCategoryTreeDto,
  computeInStock,
  computeAvailableQty,
  effectiveVariantPrice,
} from '@/lib/storefront/dto';
import type {
  Brand,
  BrandRef,
  CategoryTreeNode,
  InventoryItem,
  ProductDetail,
  ProductListRow,
  ProductVariant,
} from '@/lib/catalog/types';
import type { SeoCtx } from '@/lib/seo/meta';

const D = new Date('2026-06-01T00:00:00Z');

/** Тестовый SeoCtx (домен/шаблон инъецируются — без чтения env/БД). */
const TEST_SEO_CTX: SeoCtx = {
  siteUrl: 'https://shop.test',
  titleTemplate: '%s',
  siteName: 'Shop',
  defaultDescription: null,
  defaultOgImageKey: null,
  publicUrl: (k: string) => `https://cdn.test/${k}`,
  pathPrefix: 'product',
};

const brandRef: BrandRef = {
  id: 'b1',
  slug: 'bosch',
  name: 'Bosch',
  logoKey: 'brands/bosch.png',
};

function fullBrand(over: Partial<Brand> = {}): Brand {
  return {
    id: 'b1',
    slug: 'bosch',
    name: 'Bosch',
    description: 'desc',
    logoKey: 'brands/bosch.png',
    isActive: true,
    sort: 5,
    seoTitle: 't',
    seoDescription: 'd',
    ogTitle: null,
    ogDescription: null,
    ogImageKey: null,
    canonicalUrl: null,
    noindex: false,
    createdAt: D,
    updatedAt: D,
    ...over,
  };
}

describe('storefront/dto — бренды', () => {
  // РЕГРЕСС (major, волна 4): logoUrl собирается из logoKey РЕЗОЛВЕРОМ
  // (storage.url), а НЕ берётся из фантомного domain.logoUrl. Раньше logoUrl
  // был всегда null (домен читал несуществующую колонку logo_url).
  it('toBrandDto резолвит logoKey→logoUrl через publicUrl; без id/logoKey наружу', () => {
    const dto = toBrandDto(brandRef, (k) => `https://cdn.test/${k}`);
    expect(dto).toEqual({
      slug: 'bosch',
      name: 'Bosch',
      logoUrl: 'https://cdn.test/brands/bosch.png',
    });
    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('logoKey');
  });

  it('toBrandDto без резолвера → logoUrl=null (обратная совместимость, не падает)', () => {
    expect(toBrandDto(brandRef)).toEqual({ slug: 'bosch', name: 'Bosch', logoUrl: null });
  });

  it('toBrandDto: logoKey=null → logoUrl=null даже с резолвером', () => {
    const dto = toBrandDto({ ...brandRef, logoKey: null }, (k) => `https://cdn.test/${k}`);
    expect(dto!.logoUrl).toBeNull();
  });

  it('toBrandDto(null) → null', () => {
    expect(toBrandDto(null)).toBeNull();
  });

  // Регресс волны 4: FullBrandDto резолвит логотип тем же резолвером, что og:image
  // (seoCtx.publicUrl). Раньше logoUrl был всегда null.
  it('toFullBrandDto резолвит logoUrl из logoKey через seoCtx.publicUrl; скрывает служебное', () => {
    const dto = toFullBrandDto(fullBrand(), { seoCtx: TEST_SEO_CTX });
    expect(dto.logoUrl).toBe('https://cdn.test/brands/bosch.png');
    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('logoKey');
    expect(dto).not.toHaveProperty('isActive');
    expect(dto).not.toHaveProperty('sort');
    expect(dto).not.toHaveProperty('createdAt');
    expect(dto.slug).toBe('bosch');
  });

  it('toFullBrandDto: logoKey=null → logoUrl=null', () => {
    const dto = toFullBrandDto(fullBrand({ logoKey: null }), { seoCtx: TEST_SEO_CTX });
    expect(dto.logoUrl).toBeNull();
  });

  it('toFullBrandDto: явный opts.publicUrl имеет приоритет над seoCtx.publicUrl', () => {
    const dto = toFullBrandDto(fullBrand(), {
      seoCtx: TEST_SEO_CTX,
      publicUrl: (k) => `https://logos.test/${k}`,
    });
    expect(dto.logoUrl).toBe('https://logos.test/brands/bosch.png');
  });
});

describe('storefront/dto — список товаров', () => {
  const row: ProductListRow = {
    id: 'p1',
    sku: 'SKU1',
    slug: 'brake-pad',
    name: 'Brake pad',
    status: 'active',
    basePrice: '790.00',
    compareAtPrice: '1000.00',
    discountPct: 21,
    onSale: true,
    isFeatured: true,
    effectiveIsNew: true,
    brand: brandRef,
    totalStock: 3,
    availableStock: 3,
    primaryMediaUrl: 'https://cdn/img.jpg',
    createdAt: D,
  };

  it('маппит цену/скидку и inStock из доступного остатка; резолвит лого бренда; не утекает status/id/sku', () => {
    const dto = toProductListItemDto(row, (k) => `https://cdn.test/${k}`);
    expect(dto.price).toBe('790.00');
    expect(dto.compareAtPrice).toBe('1000.00');
    expect(dto.discountPct).toBe(21);
    expect(dto.onSale).toBe(true);
    expect(dto.isNew).toBe(true);
    expect(dto.isFeatured).toBe(true);
    // Логотип бренда резолвится переданным storage.url из logoKey (регресс волны 4).
    expect(dto.brand).toEqual({
      slug: 'bosch',
      name: 'Bosch',
      logoUrl: 'https://cdn.test/brands/bosch.png',
    });
    expect(dto.imageUrl).toBe('https://cdn/img.jpg');
    expect(dto.inStock).toBe(true);
    // Внутренние поля наружу не отдаём.
    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('status');
    expect(dto).not.toHaveProperty('totalStock');
    expect(dto).not.toHaveProperty('availableStock');
  });

  it('inStock=false при нулевом доступном остатке', () => {
    expect(
      toProductListItemDto({ ...row, totalStock: 0, availableStock: 0 }).inStock,
    ).toBe(false);
  });

  // РЕГРЕСС (major, data-integrity): весь физический остаток зарезервирован под
  // незавершённые заказы → доступное = 0, витрина НЕ должна показывать «в наличии».
  // Семантика совпадает с computeInStock карточки/детали: in stock = quantity−reserved>0.
  it('inStock=false когда физический остаток есть, но весь зарезервирован', () => {
    const dto = toProductListItemDto({ ...row, totalStock: 5, availableStock: 0 });
    expect(dto.inStock).toBe(false);
  });

  it('inStock=true когда доступно хоть сколько-то при наличии резерва', () => {
    const dto = toProductListItemDto({ ...row, totalStock: 5, availableStock: 2 });
    expect(dto.inStock).toBe(true);
  });
});

describe('storefront/dto — computeInStock / цена варианта', () => {
  const inv: InventoryItem[] = [
    { id: 'i1', productId: 'p1', variantId: 'v1', warehouseCode: 'W', quantity: 0, reserved: 0, updatedAt: D },
    { id: 'i2', productId: 'p1', variantId: 'v2', warehouseCode: 'W', quantity: 5, reserved: 0, updatedAt: D },
  ];

  it('computeInStock по товару — true, если есть положительный остаток', () => {
    expect(computeInStock(inv)).toBe(true);
  });

  it('computeInStock по варианту — учитывает только его строки', () => {
    expect(computeInStock(inv, 'v1')).toBe(false);
    expect(computeInStock(inv, 'v2')).toBe(true);
  });

  it('computeInStock учитывает reserved: доступно = quantity − reserved', () => {
    // Весь остаток зарезервирован → не в наличии для витрины.
    const reserved: InventoryItem[] = [
      { id: 'i', productId: 'p1', variantId: null, warehouseCode: 'W', quantity: 5, reserved: 5, updatedAt: D },
    ];
    expect(computeInStock(reserved)).toBe(false);
    // Часть зарезервирована, но что-то доступно → в наличии.
    const partial: InventoryItem[] = [
      { id: 'i', productId: 'p1', variantId: null, warehouseCode: 'W', quantity: 5, reserved: 4, updatedAt: D },
    ];
    expect(computeInStock(partial)).toBe(true);
    // Reserved больше остатка (рассинхрон) → не уходит в минус, не в наличии.
    const over: InventoryItem[] = [
      { id: 'i', productId: 'p1', variantId: null, warehouseCode: 'W', quantity: 2, reserved: 5, updatedAt: D },
    ];
    expect(computeInStock(over)).toBe(false);
  });

  it('computeInStock по варианту учитывает reserved этого варианта', () => {
    const v: InventoryItem[] = [
      { id: 'i1', productId: 'p1', variantId: 'v1', warehouseCode: 'W', quantity: 3, reserved: 3, updatedAt: D },
      { id: 'i2', productId: 'p1', variantId: 'v2', warehouseCode: 'W', quantity: 3, reserved: 1, updatedAt: D },
    ];
    expect(computeInStock(v, 'v1')).toBe(false);
    expect(computeInStock(v, 'v2')).toBe(true);
  });

  it('effectiveVariantPrice: override, иначе base+delta', () => {
    const base: ProductVariant = {
      id: 'v', productId: 'p', sku: 's', name: '', priceOverride: null,
      priceDelta: '50.00', compareAtPrice: null, isActive: true, sort: 0,
      attributesCache: {}, weightG: null, lengthCm: null, widthCm: null, heightCm: null,
      createdAt: D, updatedAt: D,
    };
    expect(effectiveVariantPrice(base, '100.00')).toBe('150.00');
    expect(effectiveVariantPrice({ ...base, priceOverride: '200.00' }, '100.00')).toBe('200.00');
  });
});

describe('storefront/dto — карточка товара', () => {
  const variant: ProductVariant = {
    id: 'v1', productId: 'p1', sku: 'V1', name: 'M',
    priceOverride: null, priceDelta: '0.00', compareAtPrice: null,
    isActive: true, sort: 0, attributesCache: { size: 'M' },
    weightG: null, lengthCm: null, widthCm: null, heightCm: null,
    createdAt: D, updatedAt: D,
  };
  const inactiveVariant: ProductVariant = { ...variant, id: 'v2', isActive: false };

  const product: ProductDetail = {
    id: 'p1', sku: 'SKU1', slug: 'coat', name: 'Coat', description: 'nice',
    status: 'active', basePrice: '1000.00', compareAtPrice: '1500.00',
    isFeatured: false, isNew: null, brandId: 'b1',
    attributesCache: { color: 'white' }, seoTitle: null, seoDescription: null,
    ogTitle: null, ogDescription: null, ogImageKey: null, canonicalUrl: null, noindex: false,
    weightG: null, lengthCm: null, widthCm: null, heightCm: null,
    createdAt: D, updatedAt: D,
    categories: [{ categoryId: 'c1', isPrimary: true }],
    variants: [variant, inactiveVariant],
    attributes: [],
    media: [
      { id: 'm1', productId: 'p1', variantId: null, storageKey: 'media/secret-key.jpg',
        url: 'https://cdn/a.jpg', type: 'image', mime: 'image/jpeg', alt: 'a',
        width: 10, height: 10, sizeBytes: 999, sort: 0, isPrimary: true, createdAt: D },
    ],
    inventory: [
      { id: 'i1', productId: 'p1', variantId: 'v1', warehouseCode: 'main', quantity: 2, reserved: 0, updatedAt: D },
    ],
    brand: brandRef,
  };

  it('маппит цену/скидку, бренд, категории-slug, медиа без storageKey', () => {
    const dto = toProductDetailDto(product, {
      effectiveIsNew: true,
      categorySlugs: ['outerwear'],
      seoCtx: TEST_SEO_CTX,
    });
    expect(dto.slug).toBe('coat');
    expect(dto.price).toBe('1000.00');
    expect(dto.discountPct).toBe(33); // round((1500-1000)/1500*100)
    expect(dto.onSale).toBe(true);
    expect(dto.isNew).toBe(true);
    expect(dto.brand?.slug).toBe('bosch');
    // Логотип бренда карточки резолвится тем же seoCtx.publicUrl, что и og:image
    // (регресс волны 4 — раньше всегда null).
    expect(dto.brand?.logoUrl).toBe('https://cdn.test/brands/bosch.png');
    expect(dto.categories).toEqual(['outerwear']);
    expect(dto.inStock).toBe(true);
    // Медиа — без внутреннего storageKey/sizeBytes.
    expect(dto.media[0]).not.toHaveProperty('storageKey');
    expect(dto.media[0]).not.toHaveProperty('sizeBytes');
    expect(dto.media[0]!.url).toBe('https://cdn/a.jpg');
    // Публичный id товара отдаётся НАМЕРЕННО — витрине нужен productId для заказа
    // товара без вариантов (cart/quote/orders по productId, ADR-010); по
    // чувствительности сопоставимо с уже публичными id вариантов.
    expect(dto.id).toBe('p1');
    // Прочие внутренние поля карточки по-прежнему не утекают.
    expect(dto).not.toHaveProperty('status');
    expect(dto).not.toHaveProperty('attributesCache');
  });

  it('отдаёт только активные варианты, у варианта inStock и без сырого id остатка', () => {
    const dto = toProductDetailDto(product, {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: TEST_SEO_CTX,
    });
    expect(dto.variants).toHaveLength(1);
    const v = dto.variants[0]!;
    expect(v.id).toBe('v1');
    expect(v.name).toBe('M'); // человекочитаемая метка варианта (размер) для витрины
    expect(v.inStock).toBe(true);
    expect(v.attributes).toEqual({ size: 'M' });
    expect(v).not.toHaveProperty('priceDelta');
    expect(v).not.toHaveProperty('productId');
  });

  // Регресс (Prevki «Халат, остаток 50, но нет в наличии» + «не выбрать размер»):
  // товар БЕЗ вариантов с остатком на УРОВНЕ ТОВАРА (variant_id = null) должен
  // отдавать id (для заказа по productId), inStock=true и пустой список вариантов.
  it('товар без вариантов + остаток на уровне товара → id, inStock=true, variants пуст', () => {
    const simple: ProductDetail = {
      ...product,
      variants: [],
      inventory: [
        { id: 'i0', productId: 'p1', variantId: null, warehouseCode: 'main', quantity: 50, reserved: 0, updatedAt: D },
      ],
    };
    const dto = toProductDetailDto(simple, {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: TEST_SEO_CTX,
    });
    expect(dto.id).toBe('p1');
    expect(dto.variants).toHaveLength(0);
    expect(dto.inStock).toBe(true);
  });

  // Регресс #13 (волна 15): осиротевший product-level остаток (variant_id=null) НЕ
  // должен завышать наличие ТОВАРА при наличии вариантов — заказ идёт по варианту,
  // product-level остаток не заказуем (тот же инвариант, что в listProducts, волна 14).
  it('варианты распроданы + осиротевший product-level остаток → inStock=false, availableQty=0', () => {
    const withOrphan: ProductDetail = {
      ...product,
      variants: [variant], // активный вариант v1
      inventory: [
        { id: 'iv', productId: 'p1', variantId: 'v1', warehouseCode: 'main', quantity: 1, reserved: 1, updatedAt: D }, // вариант распродан
        { id: 'io', productId: 'p1', variantId: null, warehouseCode: 'main', quantity: 99, reserved: 0, updatedAt: D }, // осиротевший product-level
      ],
    };
    const dto = toProductDetailDto(withOrphan, {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: TEST_SEO_CTX,
    });
    expect(dto.inStock).toBe(false); // без фикса: true (осиротевший остаток)
    expect(dto.availableQty).toBe(0); // без фикса: 99
    expect(dto.variants[0]!.inStock).toBe(false);
  });

  it('toVariantDto наследует compareAtPrice товара, считает скидку', () => {
    const dto = toVariantDto(variant, product);
    // variant.compareAtPrice=null → наследует product 1500.
    expect(dto.compareAtPrice).toBe('1500.00');
    expect(dto.onSale).toBe(true);
    expect(dto.discountPct).toBe(33);
  });
});

describe('storefront/dto — дерево категорий', () => {
  const tree: CategoryTreeNode[] = [
    {
      id: 'c1', parentId: null, slug: 'men', name: 'Men', description: '',
      sort: 0, isActive: true, seoTitle: null, seoDescription: null,
      ogTitle: null, ogDescription: null, ogImageKey: null, canonicalUrl: null, noindex: false,
      createdAt: D, updatedAt: D,
      children: [
        {
          id: 'c2', parentId: 'c1', slug: 'coats', name: 'Coats', description: 'd',
          sort: 0, isActive: true, seoTitle: null, seoDescription: null,
          ogTitle: null, ogDescription: null, ogImageKey: null, canonicalUrl: null, noindex: false,
          createdAt: D, updatedAt: D, children: [],
        },
        {
          id: 'c3', parentId: 'c1', slug: 'hidden', name: 'Hidden', description: '',
          sort: 1, isActive: false, seoTitle: null, seoDescription: null,
          ogTitle: null, ogDescription: null, ogImageKey: null, canonicalUrl: null, noindex: false,
          createdAt: D, updatedAt: D, children: [],
        },
      ],
    },
  ];

  it('скрывает неактивные ветви, отдаёт slug/name/description/children', () => {
    const dto = toCategoryTreeDto(tree);
    expect(dto).toHaveLength(1);
    expect(dto[0]!.slug).toBe('men');
    expect(dto[0]!.children).toHaveLength(1);
    expect(dto[0]!.children[0]!.slug).toBe('coats');
    expect(dto[0]!).not.toHaveProperty('id');
    expect(dto[0]!).not.toHaveProperty('isActive');
  });
});

describe('computeAvailableQty — доступное к заказу количество (для лимита корзины)', () => {
  const inv = (over: Partial<{ variantId: string | null; quantity: number; reserved: number }>) => ({
    id: 'i', productId: 'p', variantId: null, warehouseCode: 'main',
    quantity: 0, reserved: 0, updatedAt: new Date('2025-01-01'), ...over,
  });

  it('суммирует quantity − reserved по всем строкам (товар без фильтра по варианту)', () => {
    expect(computeAvailableQty([inv({ quantity: 5, reserved: 2 }), inv({ quantity: 3, reserved: 0 })])).toBe(6);
  });

  it('фильтрует по варианту', () => {
    const rows = [inv({ variantId: 'v1', quantity: 4, reserved: 1 }), inv({ variantId: 'v2', quantity: 9, reserved: 0 })];
    expect(computeAvailableQty(rows, 'v1')).toBe(3);
    expect(computeAvailableQty(rows, 'v2')).toBe(9);
  });

  it('reserved ≥ quantity → 0 (не уходит в минус, не даёт оверселл)', () => {
    expect(computeAvailableQty([inv({ quantity: 2, reserved: 5 })])).toBe(0);
  });

  it('пустой inventory → 0', () => {
    expect(computeAvailableQty([])).toBe(0);
  });

  it('m5: warehouseCode скоупит склад — показ совпадает с резервом (main-only)', () => {
    const D2 = new Date('2025-01-01');
    const rows = [
      { id: 'a', productId: 'p', variantId: null, warehouseCode: 'main', quantity: 5, reserved: 0, updatedAt: D2 },
      { id: 'b', productId: 'p', variantId: null, warehouseCode: 'reserve-2', quantity: 7, reserved: 0, updatedAt: D2 },
    ];
    // Без фильтра — сумма ВСЕХ складов (5+7=12), как было (латентный баг).
    expect(computeAvailableQty(rows)).toBe(12);
    // С фильтром по 'main' — только основной склад (5), как резерв/заказ.
    expect(computeAvailableQty(rows, undefined, 'main')).toBe(5);

    // main распродан, но другой склад полон: main-only показ → НЕ в наличии (нет оверселла).
    const soldMain = [
      { id: 'a', productId: 'p', variantId: null, warehouseCode: 'main', quantity: 3, reserved: 3, updatedAt: D2 },
      { id: 'b', productId: 'p', variantId: null, warehouseCode: 'reserve-2', quantity: 10, reserved: 0, updatedAt: D2 },
    ];
    expect(computeInStock(soldMain, undefined, 'main')).toBe(false);
    expect(computeAvailableQty(soldMain, undefined, 'main')).toBe(0);
    // Без фильтра показал бы наличие (это и был риск оверселла на мультискладе).
    expect(computeInStock(soldMain)).toBe(true);
  });

  it('m5: сравнение склада РЕГИСТРОНЕЗАВИСИМО (citext) — «Main» считается как «main»', () => {
    const D2 = new Date('2025-01-01');
    const mixed = [
      { id: 'a', productId: 'p', variantId: null, warehouseCode: 'Main', quantity: 4, reserved: 0, updatedAt: D2 },
    ];
    // Строгий === спрятал бы остаток; citext-семантика — «Main» === «main».
    expect(computeAvailableQty(mixed, undefined, 'main')).toBe(4);
    expect(computeInStock(mixed, undefined, 'main')).toBe(true);
  });
});
