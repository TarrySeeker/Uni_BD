import { describe, it, expect } from 'vitest';

/**
 * №11 (остаток): АТРИБУТЫ и ЦВЕТА товара непереводимы.
 *
 * ДЕФЕКТ. В lib/i18n/fields.ts не было whitelist для атрибутов (были PRODUCT/BRAND/
 * DESIGNER/CATEGORY/VARIANT/BLOCK/CMS); DTO отдавал сырой кеш `attributes:
 * p.attributesCache ?? {}`, а `colors` копировались как есть с комментарием «name уже
 * на ru». Страница товара печатала `{k}: {v}` и `c.name` в title/aria-label. Колонки
 * translations у attributes/attribute_values миграцией 0034 СОЗДАНЫ, но ни read-, ни
 * write-пути не было — на en/fr витрине характеристики оставались русскими.
 *
 * Этот тест сторожит READ-PATH: чистую локализацию денормализованного кеша
 * характеристик и цвето-свотчей по словарю переводов (ключ→перевод имени,
 * значение→перевод значения). Словарь строится из БД в роуте; здесь — чистые
 * фикстуры, без БД/Next.
 */

import {
  ATTRIBUTE_TR_FIELDS,
  ATTRIBUTE_VALUE_TR_FIELDS,
} from '@/lib/i18n/fields';
import {
  localizeAttributesCache,
  localizeColors,
  buildAttributeDictionary,
  type AttributeI18nRow,
  type AttributeValueI18nRow,
} from '@/lib/storefront/attributes-i18n';
import { toProductDetailDto } from '@/lib/storefront/dto';
import type { LocalizeCtx } from '@/lib/storefront/locale';
import type { ProductDetail } from '@/lib/catalog/types';
import type { SeoCtx } from '@/lib/seo/meta';

const EN: LocalizeCtx = { locale: 'en', defaultLocale: 'ru' };
const FR: LocalizeCtx = { locale: 'fr', defaultLocale: 'ru' };
const RU: LocalizeCtx = { locale: 'ru', defaultLocale: 'ru' };

describe('lib/i18n/fields — whitelist атрибутов существует (симметрия read/write)', () => {
  it('ATTRIBUTE_TR_FIELDS переводит name (code — стабильный ключ импорта, НЕ переводим)', () => {
    expect([...ATTRIBUTE_TR_FIELDS]).toContain('name');
    expect([...ATTRIBUTE_TR_FIELDS]).not.toContain('code');
  });

  it('ATTRIBUTE_VALUE_TR_FIELDS переводит value (slug — машинный ЧПУ, НЕ переводим)', () => {
    expect([...ATTRIBUTE_VALUE_TR_FIELDS]).toContain('value');
    expect([...ATTRIBUTE_VALUE_TR_FIELDS]).not.toContain('slug');
  });
});

const ATTR_ROWS: AttributeI18nRow[] = [
  {
    code: 'material',
    name: 'Материал',
    translations: { en: { name: 'Material' }, fr: { name: 'Matière' } },
  },
  // Атрибут БЕЗ перевода — обязан отдаваться базовым именем (фолбэк на ru).
  { code: 'size', name: 'Размер', translations: {} },
];

const VALUE_ROWS: AttributeValueI18nRow[] = [
  {
    attributeCode: 'material',
    value: 'Шёлк',
    translations: { en: { value: 'Silk' }, fr: { value: 'Soie' } },
  },
  { attributeCode: 'material', value: 'Хлопок', translations: { en: { value: 'Cotton' } } },
];

const DICT = buildAttributeDictionary(ATTR_ROWS, VALUE_ROWS);

describe('localizeAttributesCache — ключи и значения кеша характеристик', () => {
  it('en: переводит и имя характеристики, и её значение', () => {
    const out = localizeAttributesCache({ material: 'Шёлк' }, DICT, EN);
    expect(out).toEqual({ Material: 'Silk' });
  });

  it('fr: переводит по своей локали', () => {
    const out = localizeAttributesCache({ material: 'Шёлк' }, DICT, FR);
    expect(out).toEqual({ Matière: 'Soie' });
  });

  it('fr без перевода ЗНАЧЕНИЯ → фолбэк на базовое значение, имя всё равно переведено', () => {
    const out = localizeAttributesCache({ material: 'Хлопок' }, DICT, FR);
    expect(out).toEqual({ Matière: 'Хлопок' });
  });

  it('атрибут без перевода имени → базовое имя (ничего не теряется)', () => {
    const out = localizeAttributesCache({ size: '90x90' }, DICT, EN);
    expect(out).toEqual({ Размер: '90x90' });
  });

  it('ru (базовая локаль): отдаёт ЧИТАЕМОЕ имя характеристики вместо машинного кода', () => {
    // Раньше витрина печатала сырой ключ кеша ('material: Шёлк'). Даже на ru имя
    // должно быть человекочитаемым — это то же самое поле attributes.name.
    const out = localizeAttributesCache({ material: 'Шёлк' }, DICT, RU);
    expect(out).toEqual({ Материал: 'Шёлк' });
  });

  it('код, которого нет в словаре, не теряется (отдаём как есть)', () => {
    const out = localizeAttributesCache({ unknown_code: 'X' }, DICT, EN);
    expect(out).toEqual({ unknown_code: 'X' });
  });

  it('мультизначные характеристики (массив) переводятся поэлементно', () => {
    const out = localizeAttributesCache({ material: ['Шёлк', 'Хлопок'] }, DICT, EN);
    expect(out).toEqual({ Material: ['Silk', 'Cotton'] });
  });

  it('нестроковые значения (число/булево) сохраняют тип', () => {
    const out = localizeAttributesCache({ size: 90 }, DICT, EN);
    expect(out).toEqual({ Размер: 90 });
  });

  it('пустой словарь/пустой кеш не роняют (null-safety)', () => {
    expect(localizeAttributesCache({}, DICT, EN)).toEqual({});
    expect(localizeAttributesCache({ material: 'Шёлк' }, null, EN)).toEqual({
      material: 'Шёлк',
    });
    expect(localizeAttributesCache({ material: 'Шёлк' }, DICT, undefined)).toEqual({
      Материал: 'Шёлк',
    });
  });
});

describe('localizeColors — имена цвето-свотчей (title/aria-label карточки)', () => {
  const COLOR_ROWS: AttributeValueI18nRow[] = [
    {
      attributeCode: 'color',
      value: 'Красный',
      translations: { en: { value: 'Red' }, fr: { value: 'Rouge' } },
    },
  ];
  const colorDict = buildAttributeDictionary([], COLOR_ROWS);

  it('en: имя цвета переведено, hex не тронут', () => {
    const out = localizeColors([{ hex: '#ff0000', name: 'Красный' }], colorDict, EN);
    expect(out).toEqual([{ hex: '#ff0000', name: 'Red' }]);
  });

  it('цвет без перевода → базовое имя (фолбэк, свотч не безымянный)', () => {
    const out = localizeColors([{ hex: '#00ff00', name: 'Зелёный' }], colorDict, EN);
    expect(out).toEqual([{ hex: '#00ff00', name: 'Зелёный' }]);
  });

  it('пустое имя цвета остаётся пустым (не подставляем мусор)', () => {
    const out = localizeColors([{ hex: '#000000', name: '' }], colorDict, EN);
    expect(out).toEqual([{ hex: '#000000', name: '' }]);
  });

  it('ru: базовые имена как есть', () => {
    const out = localizeColors([{ hex: '#ff0000', name: 'Красный' }], colorDict, RU);
    expect(out).toEqual([{ hex: '#ff0000', name: 'Красный' }]);
  });
});

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
  const D = new Date('2026-06-01T00:00:00Z');
  return {
    id: 'p1',
    sku: 'SKU1',
    slug: 'scarf',
    name: 'Платок',
    description: '',
    status: 'active',
    basePrice: '1000.00',
    compareAtPrice: null,
    isFeatured: false,
    isNew: null,
    brandId: null,
    designerId: null,
    attributesCache: { material: 'Шёлк' },
    colors: [{ hex: '#ff0000', name: 'Красный' }],
    seoTitle: null,
    seoDescription: null,
    ogTitle: null,
    ogDescription: null,
    ogImageKey: null,
    canonicalUrl: null,
    noindex: false,
    weightG: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    createdAt: D,
    updatedAt: D,
    brand: null,
    designer: null,
    categories: [],
    variants: [],
    media: [],
    inventory: [],
    ...over,
  } as ProductDetail;
}

describe('toProductDetailDto — атрибуты/цвета проходят через словарь переводов', () => {
  const COLOR_ROWS: AttributeValueI18nRow[] = [
    { attributeCode: 'color', value: 'Красный', translations: { en: { value: 'Red' } } },
  ];
  const dict = buildAttributeDictionary(ATTR_ROWS, [...VALUE_ROWS, ...COLOR_ROWS]);

  it('en со словарём: attributes и colors локализованы', () => {
    const dto = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
      loc: EN,
      attributeDict: dict,
    });
    expect(dto.attributes).toEqual({ Material: 'Silk' });
    expect(dto.colors).toEqual([{ hex: '#ff0000', name: 'Red' }]);
  });

  it('БЕЗ словаря форма DTO не меняется (анти-регресс старого вызова)', () => {
    const dto = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
      loc: EN,
    });
    expect(dto.attributes).toEqual({ material: 'Шёлк' });
    expect(dto.colors).toEqual([{ hex: '#ff0000', name: 'Красный' }]);
  });

  it('ru со словарём: имя характеристики читаемое, значения базовые', () => {
    const dto = toProductDetailDto(product(), {
      effectiveIsNew: false,
      categorySlugs: [],
      seoCtx: SEO,
      loc: RU,
      attributeDict: dict,
    });
    expect(dto.attributes).toEqual({ Материал: 'Шёлк' });
    expect(dto.colors).toEqual([{ hex: '#ff0000', name: 'Красный' }]);
  });
});
