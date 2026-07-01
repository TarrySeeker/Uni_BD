import { describe, expect, it } from 'vitest';

import {
  slugSchema,
  moneySchema,
  normalizeMoney,
  ProductCreateSchema,
  ProductUpdateSchema,
  CategoryCreateSchema,
  CategoryMoveSchema,
  VariantCreateSchema,
  VariantReorderSchema,
  AttributeCreateSchema,
  AttributeValueDeleteSchema,
  ProductAttributeItemSchema,
  StockSetSchema,
  StockAdjustSchema,
  VariantUpdateSchema,
  BrandCreateSchema,
  BrandUpdateSchema,
  BrandIdSchema,
} from '@/lib/catalog/schemas';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

// ЮНИТ: Zod-схемы — всегда зелёные, без БД.

describe('slugSchema', () => {
  it('принимает валидный slug', () => {
    expect(slugSchema.safeParse('foo-bar-2').success).toBe(true);
  });
  it('отклоняет двойные/краевые дефисы и верхний регистр', () => {
    expect(slugSchema.safeParse('Foo').success).toBe(false);
    expect(slugSchema.safeParse('foo--bar').success).toBe(false);
    expect(slugSchema.safeParse('-foo').success).toBe(false);
    expect(slugSchema.safeParse('').success).toBe(false);
  });
});

describe('moneySchema — цена NUMERIC ≥ 0', () => {
  it('принимает 0, целые и дробные (≤2 знака)', () => {
    for (const v of ['0', '100', '99.99', '1234567.50']) {
      expect(moneySchema.safeParse(v).success).toBe(true);
    }
  });
  it('отклоняет отрицательные', () => {
    expect(moneySchema.safeParse('-1').success).toBe(false);
    expect(moneySchema.safeParse('-0.01').success).toBe(false);
  });
  it('отклоняет >2 знаков после точки и нечисловое', () => {
    expect(moneySchema.safeParse('1.999').success).toBe(false);
    expect(moneySchema.safeParse('abc').success).toBe(false);
  });

  // Находка 2 аудита (ux, каталог): русский ввод «1500,50» с запятой-разделителем
  // должен приниматься и нормализоваться к точке на сервере (любой клиент: форма,
  // импорт, будущие магазины), а не падать «не более 2 знаков после точки».
  it('принимает запятую как десятичный разделитель и нормализует к точке', () => {
    const res = moneySchema.safeParse('1500,50');
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toBe('1500.50');
  });

  it('тримит пробелы вокруг значения с запятой', () => {
    const res = moneySchema.safeParse('  1500,50  ');
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toBe('1500.50');
  });

  it('точка по-прежнему валидна (запятая не ломает прежний контракт)', () => {
    const res = moneySchema.safeParse('99.99');
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toBe('99.99');
  });
});

describe('normalizeMoney — хелпер нормализации денежного ввода', () => {
  it('trim + запятая → точка', () => {
    expect(normalizeMoney('1500,50')).toBe('1500.50');
    expect(normalizeMoney('  100  ')).toBe('100');
    expect(normalizeMoney('99.99')).toBe('99.99');
  });
});

describe('ProductCreateSchema', () => {
  it('валидный минимальный вход с дефолтами', () => {
    const res = ProductCreateSchema.safeParse({
      sku: 'SKU-1',
      slug: 'product-1',
      name: 'Товар',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.status).toBe('draft');
      expect(res.data.basePrice).toBe('0');
      expect(res.data.categoryIds).toEqual([]);
    }
  });

  it('slug необязателен — пустое поле «Адрес» не блокирует создание (регресс)', () => {
    // Раньше slug был обязателен → создание товара с пустым адресом падало
    // валидацией (в т.ч. для русских названий). Хендлер генерирует slug из name.
    const res = ProductCreateSchema.safeParse({ sku: 'SKU-1', name: 'Куртка' });
    expect(res.success).toBe(true);
  });

  it('артикул и адрес необязательны — достаточно одного названия (упрощение формы)', () => {
    // Упрощение для нетехнического владельца: SKU и slug генерируются автоматически.
    const res = ProductCreateSchema.safeParse({ name: 'Куртка' });
    expect(res.success).toBe(true);
  });

  it('отрицательная цена отклонена', () => {
    const res = ProductCreateSchema.safeParse({
      sku: 'SKU-1',
      slug: 'p',
      name: 'X',
      basePrice: '-5',
    });
    expect(res.success).toBe(false);
  });

  it('невалидный slug отклонён', () => {
    const res = ProductCreateSchema.safeParse({
      sku: 'SKU',
      slug: 'Bad Slug',
      name: 'X',
    });
    expect(res.success).toBe(false);
  });

  it('primaryCategoryId должна входить в categoryIds', () => {
    const bad = ProductCreateSchema.safeParse({
      sku: 'S',
      slug: 's',
      name: 'X',
      categoryIds: [UUID],
      primaryCategoryId: UUID2,
    });
    expect(bad.success).toBe(false);

    const good = ProductCreateSchema.safeParse({
      sku: 'S',
      slug: 's',
      name: 'X',
      categoryIds: [UUID, UUID2],
      primaryCategoryId: UUID2,
    });
    expect(good.success).toBe(true);
  });
});

describe('ProductUpdateSchema', () => {
  it('требует id', () => {
    expect(ProductUpdateSchema.safeParse({ name: 'X' }).success).toBe(false);
    expect(ProductUpdateSchema.safeParse({ id: UUID, name: 'X' }).success).toBe(true);
  });

  it('m5: warehouseCode нормализуется к нижнему регистру (citext-канонизация)', () => {
    const r = StockSetSchema.safeParse({ productId: UUID, quantity: 5, warehouseCode: 'Main' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.warehouseCode).toBe('main');
    // дефолт уже в нижнем регистре
    const d = StockSetSchema.safeParse({ productId: UUID, quantity: 5 });
    expect(d.success && d.data.warehouseCode).toBe('main');
  });

  it('primaryCategoryId должна входить в categoryIds (на update тоже, m2)', () => {
    // Невалидная пара: основная категория не в списке → отказ (как на create).
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, categoryIds: [UUID], primaryCategoryId: UUID2 })
        .success,
    ).toBe(false);
    // Валидная пара: основная входит в список.
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, categoryIds: [UUID, UUID2], primaryCategoryId: UUID2 })
        .success,
    ).toBe(true);
    // Частичный апдейт без categoryIds (категории не трогаем) — не блокируется.
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, primaryCategoryId: UUID2 }).success,
    ).toBe(true);
    // Апдейт без категорий вовсе — валиден.
    expect(ProductUpdateSchema.safeParse({ id: UUID, name: 'X' }).success).toBe(true);
  });
});

describe('ProductCreate/Update — новые поля (docs/06 §3.1–§3.3)', () => {
  it('isFeatured по умолчанию false', () => {
    const res = ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X' });
    expect(res.success && res.data.isFeatured).toBe(false);
  });

  it('compareAtPrice — деньги ≥ 0, допускает null', () => {
    expect(
      ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', compareAtPrice: '129.90' }).success,
    ).toBe(true);
    expect(
      ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', compareAtPrice: null }).success,
    ).toBe(true);
    expect(
      ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', compareAtPrice: '-5' }).success,
    ).toBe(false);
  });

  it('isNew троичное: true/false/null допустимы, нечисловое — нет', () => {
    for (const v of [true, false, null]) {
      expect(
        ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', isNew: v }).success,
      ).toBe(true);
    }
    expect(
      ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', isNew: 'yes' }).success,
    ).toBe(false);
  });

  it('brandId — uuid или null', () => {
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, brandId: UUID2 }).success,
    ).toBe(true);
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, brandId: null }).success,
    ).toBe(true);
    expect(
      ProductUpdateSchema.safeParse({ id: UUID, brandId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('вес/габариты (0018) — товар и вариант', () => {
  const dimKeys = ['weightG', 'lengthCm', 'widthCm', 'heightCm'] as const;

  it('товар: целые ≥ 0 и null допустимы; отрицательное/дробное — нет', () => {
    for (const k of dimKeys) {
      expect(ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', [k]: 500 }).success).toBe(true);
      expect(ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', [k]: 0 }).success).toBe(true);
      expect(ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', [k]: null }).success).toBe(true);
      expect(ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', [k]: -1 }).success).toBe(false);
      expect(ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X', [k]: 1.5 }).success).toBe(false);
    }
  });

  it('товар: поля опциональны (можно не передавать)', () => {
    const res = ProductCreateSchema.safeParse({ sku: 'S', slug: 's', name: 'X' });
    expect(res.success).toBe(true);
  });

  it('товар update: null допустим (сброс к дефолту магазина)', () => {
    expect(ProductUpdateSchema.safeParse({ id: UUID, weightG: null }).success).toBe(true);
    expect(ProductUpdateSchema.safeParse({ id: UUID, heightCm: -3 }).success).toBe(false);
  });

  it('вариант create/update: целые ≥ 0 / null', () => {
    for (const k of dimKeys) {
      expect(VariantCreateSchema.safeParse({ productId: UUID, sku: 'V', [k]: 120 }).success).toBe(true);
      expect(VariantCreateSchema.safeParse({ productId: UUID, sku: 'V', [k]: -1 }).success).toBe(false);
      expect(VariantUpdateSchema.safeParse({ id: UUID, [k]: null }).success).toBe(true);
    }
  });
});

describe('VariantUpdateSchema — compareAtPrice', () => {
  it('допускает деньги/null, отклоняет отрицательное', () => {
    expect(VariantUpdateSchema.safeParse({ id: UUID, compareAtPrice: '50' }).success).toBe(true);
    expect(VariantUpdateSchema.safeParse({ id: UUID, compareAtPrice: null }).success).toBe(true);
    expect(VariantUpdateSchema.safeParse({ id: UUID, compareAtPrice: '-1' }).success).toBe(false);
  });
});

describe('BrandCreateSchema / BrandUpdateSchema / BrandIdSchema', () => {
  it('создание: name обязателен, дефолты isActive/sort', () => {
    const res = BrandCreateSchema.safeParse({ name: 'Bosch' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.isActive).toBe(true);
      expect(res.data.sort).toBe(0);
      expect(res.data.description).toBe('');
    }
  });
  it('создание без name отклонено', () => {
    expect(BrandCreateSchema.safeParse({ slug: 'bosch' }).success).toBe(false);
  });
  it('невалидный slug отклонён', () => {
    expect(BrandCreateSchema.safeParse({ name: 'B', slug: 'Bad Slug' }).success).toBe(false);
  });
  it('обновление требует id', () => {
    expect(BrandUpdateSchema.safeParse({ name: 'X' }).success).toBe(false);
    expect(BrandUpdateSchema.safeParse({ id: UUID, name: 'X' }).success).toBe(true);
  });
  it('BrandIdSchema требует uuid', () => {
    expect(BrandIdSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(BrandIdSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});

describe('CategoryCreateSchema / CategoryMoveSchema', () => {
  it('категория с дефолтами', () => {
    const res = CategoryCreateSchema.safeParse({ slug: 'cat', name: 'Кат' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.isActive).toBe(true);
      expect(res.data.sort).toBe(0);
    }
  });
  it('slug необязателен — русское название без адреса проходит (регресс)', () => {
    // Баг: slug был обязателен → «Создать категорию» с пустым адресом падало
    // «Проверьте корректность полей формы», в т.ч. для «Одежда». Хендлер
    // генерирует slug из name (slugify транслитерирует кириллицу).
    const res = CategoryCreateSchema.safeParse({ name: 'Одежда' });
    expect(res.success).toBe(true);
  });
  it('move принимает null-родителя (корень)', () => {
    expect(CategoryMoveSchema.safeParse({ id: UUID, parentId: null }).success).toBe(true);
    expect(CategoryMoveSchema.safeParse({ id: UUID, parentId: UUID2 }).success).toBe(true);
  });
});

describe('VariantCreateSchema', () => {
  it('priceOverride отрицательный отклонён', () => {
    expect(
      VariantCreateSchema.safeParse({
        productId: UUID,
        sku: 'V-1',
        priceOverride: '-1',
      }).success,
    ).toBe(false);
  });
  it('валидный вариант', () => {
    expect(
      VariantCreateSchema.safeParse({ productId: UUID, sku: 'V-1' }).success,
    ).toBe(true);
  });
  it('артикул варианта необязателен — достаточно товара и названия (упрощение)', () => {
    // Раньше sku варианта был обязателен; теперь генерируется автоматически,
    // владельцу достаточно ввести размер/название варианта.
    expect(
      VariantCreateSchema.safeParse({ productId: UUID, name: '48' }).success,
    ).toBe(true);
  });
});

describe('VariantReorderSchema (C12)', () => {
  it('валидный порядок (массив uuid) принимается', () => {
    expect(
      VariantReorderSchema.safeParse({ productId: UUID, order: [UUID2] }).success,
    ).toBe(true);
  });
  it('пустой order отклонён (min 1)', () => {
    expect(
      VariantReorderSchema.safeParse({ productId: UUID, order: [] }).success,
    ).toBe(false);
  });
  it('не-uuid в order отклонён', () => {
    expect(
      VariantReorderSchema.safeParse({ productId: UUID, order: ['x'] }).success,
    ).toBe(false);
  });
  it('без productId отклонён', () => {
    expect(VariantReorderSchema.safeParse({ order: [UUID2] }).success).toBe(false);
  });
});

describe('AttributeValueDeleteSchema (C14)', () => {
  it('валидный uuid принимается', () => {
    expect(AttributeValueDeleteSchema.safeParse({ id: UUID }).success).toBe(true);
  });
  it('не-uuid / без id отклонён', () => {
    expect(AttributeValueDeleteSchema.safeParse({ id: 'nope' }).success).toBe(false);
    expect(AttributeValueDeleteSchema.safeParse({}).success).toBe(false);
  });
});

describe('AttributeCreateSchema', () => {
  it('код только латиница/цифры/подчёркивание', () => {
    expect(AttributeCreateSchema.safeParse({ code: 'color', name: 'Цвет' }).success).toBe(true);
    expect(AttributeCreateSchema.safeParse({ code: 'Цвет', name: 'Цвет' }).success).toBe(false);
    expect(AttributeCreateSchema.safeParse({ code: 'co lor', name: 'X' }).success).toBe(false);
  });
  it('неизвестный type отклонён', () => {
    expect(
      AttributeCreateSchema.safeParse({ code: 'c', name: 'X', type: 'json' }).success,
    ).toBe(false);
  });
});

describe('ProductAttributeItemSchema — value_id или value_text обязателен', () => {
  it('без значений отклонён', () => {
    expect(ProductAttributeItemSchema.safeParse({ attributeId: UUID }).success).toBe(false);
  });
  it('с valueId — ок', () => {
    expect(
      ProductAttributeItemSchema.safeParse({ attributeId: UUID, valueId: UUID2 }).success,
    ).toBe(true);
  });
  it('с valueText — ок', () => {
    expect(
      ProductAttributeItemSchema.safeParse({ attributeId: UUID, valueText: 'M' }).success,
    ).toBe(true);
  });
});

describe('StockSetSchema / StockAdjustSchema', () => {
  it('quantity ≥ 0', () => {
    expect(StockSetSchema.safeParse({ productId: UUID, quantity: 0 }).success).toBe(true);
    expect(StockSetSchema.safeParse({ productId: UUID, quantity: -1 }).success).toBe(false);
    expect(StockSetSchema.safeParse({ productId: UUID, quantity: 1.5 }).success).toBe(false);
  });
  it('warehouseCode по умолчанию main', () => {
    const res = StockSetSchema.safeParse({ productId: UUID, quantity: 5 });
    expect(res.success && res.data.warehouseCode).toBe('main');
  });
  it('adjust: delta=0 отклонён, ненулевой ок', () => {
    expect(StockAdjustSchema.safeParse({ productId: UUID, delta: 0 }).success).toBe(false);
    expect(StockAdjustSchema.safeParse({ productId: UUID, delta: -3 }).success).toBe(true);
  });
});
