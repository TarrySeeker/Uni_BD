import { describe, expect, it } from 'vitest';

import {
  buildVariantCreateInput,
  buildVariantUpdateInput,
  strToNum,
  type VariantFormValues,
} from '@/app/admin/(panel)/catalog/_components/variant-payload';
import {
  VariantCreateSchema,
  VariantUpdateSchema,
} from '@/lib/catalog/schemas';

// ЮНИТ: сборка payload форм вариантов (тупики C2/C3) — чистые функции, общие
// для клиентской формы VariantsSection (добавление + инлайн-редактирование) и
// тестов. Проверяем без БД/Next: нормализацию денег (RU-запятая/пробел разрядов),
// пусто→null, проброс compareAtPrice (C3) и совместимость с Zod-схемами каталога.

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';

/** Пустая форма с заданным набором переопределений. */
function form(overrides: Partial<VariantFormValues> = {}): VariantFormValues {
  return {
    sku: '',
    name: '',
    priceOverride: '',
    priceDelta: '0',
    compareAtPrice: '',
    weight: '',
    length: '',
    width: '',
    height: '',
    ...overrides,
  };
}

describe('strToNum', () => {
  it('пустая строка → null (наследование)', () => {
    expect(strToNum('')).toBeNull();
    expect(strToNum('   ')).toBeNull();
  });
  it('целое число парсится; дробное усекается', () => {
    expect(strToNum('120')).toBe(120);
    expect(strToNum('120.9')).toBe(120);
  });
  it('мусор → null', () => {
    expect(strToNum('abc')).toBeNull();
  });
});

describe('buildVariantCreateInput (C2/C3)', () => {
  it('RU-цена с запятой и пробелом разрядов «1 600,50» → «1600.50»', () => {
    const payload = buildVariantCreateInput(PRODUCT_ID, form({ name: '48', priceOverride: '1 600,50' }));
    expect(payload.priceOverride).toBe('1600.50');
    expect(VariantCreateSchema.safeParse(payload).success).toBe(true);
  });

  it('пустая своя цена → null (берётся basePrice)', () => {
    const payload = buildVariantCreateInput(PRODUCT_ID, form({ name: '48' }));
    expect(payload.priceOverride).toBeNull();
  });

  it('пустая доплата → «0»; заполненная — нормализуется', () => {
    expect(buildVariantCreateInput(PRODUCT_ID, form({ name: '48', priceDelta: '' })).priceDelta).toBe('0');
    expect(buildVariantCreateInput(PRODUCT_ID, form({ name: '48', priceDelta: '100,25' })).priceDelta).toBe('100.25');
  });

  it('compareAtPrice (C3): RU-запятая нормализуется, пусто → null', () => {
    expect(
      buildVariantCreateInput(PRODUCT_ID, form({ name: '48', compareAtPrice: '2 000,00' })).compareAtPrice,
    ).toBe('2000.00');
    expect(
      buildVariantCreateInput(PRODUCT_ID, form({ name: '48', compareAtPrice: '' })).compareAtPrice,
    ).toBeNull();
  });

  it('пустой артикул → undefined (сервер сгенерирует)', () => {
    expect(buildVariantCreateInput(PRODUCT_ID, form({ name: '48', sku: '  ' })).sku).toBeUndefined();
    expect(buildVariantCreateInput(PRODUCT_ID, form({ name: '48', sku: ' V-1 ' })).sku).toBe('V-1');
  });

  it('вес/габариты: пусто → null, число → целое', () => {
    const payload = buildVariantCreateInput(PRODUCT_ID, form({ name: '48', weight: '500', length: '', width: '10', height: '20' }));
    expect(payload.weightG).toBe(500);
    expect(payload.lengthCm).toBeNull();
    expect(payload.widthCm).toBe(10);
    expect(payload.heightCm).toBe(20);
  });

  it('минимальная форма (только название) проходит VariantCreateSchema', () => {
    const payload = buildVariantCreateInput(PRODUCT_ID, form({ name: '48' }));
    expect(VariantCreateSchema.safeParse(payload).success).toBe(true);
  });
});

describe('buildVariantUpdateInput (C2)', () => {
  it('прокидывает id и нормализованные деньги, compareAtPrice', () => {
    const payload = buildVariantUpdateInput(
      VARIANT_ID,
      form({ name: '50', priceOverride: '1 600,50', compareAtPrice: '2000,00' }),
    );
    expect(payload.id).toBe(VARIANT_ID);
    expect(payload.name).toBe('50');
    expect(payload.priceOverride).toBe('1600.50');
    expect(payload.compareAtPrice).toBe('2000.00');
    expect(VariantUpdateSchema.safeParse(payload).success).toBe(true);
  });

  it('пустые деньги → null (сброс к наследованию от товара)', () => {
    const payload = buildVariantUpdateInput(VARIANT_ID, form({ name: '50' }));
    expect(payload.priceOverride).toBeNull();
    expect(payload.compareAtPrice).toBeNull();
    expect(VariantUpdateSchema.safeParse(payload).success).toBe(true);
  });
});
