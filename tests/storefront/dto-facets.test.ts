import { describe, expect, it } from 'vitest';

import { toMediaDto, toProductListItemDto } from '@/lib/storefront/dto';
import type { ProductListRow, ProductMedia } from '@/lib/catalog/types';

// ЮНИТ: фасеты сетки каталога (пол/цвет/размеры) в ProductListItemDto и
// привязка фото к варианту в MediaDto — чистый маппинг, без БД.
//
// ЦЕНА ПРОМАХА: фасеты читает фильтр витрины, сравнивая СТРОКАМИ. undefined
// вместо '' отфильтровал бы товар как «не подходит» вместо «значение не
// задано», а потерянный MediaDto.variantId лишает галерею возможности показать
// фото выбранного цвета — оба расхождения typecheck витрины не поймает.

const D = new Date('2026-06-01T00:00:00Z');

/** Строка списка товаров с дефолтами (в тестах меняем фасетные поля). */
function row(over: Partial<ProductListRow> = {}): ProductListRow {
  return {
    id: 'p1',
    sku: 'SKU1',
    slug: 'kostyum',
    name: 'Костюм',
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
    attributesCache: {},
    sizes: [],
    createdAt: D,
    ...over,
  };
}

/** Медиа товара с дефолтами (приватные поля важны как «не утекли»). */
function media(over: Partial<ProductMedia> = {}): ProductMedia {
  return {
    id: 'm1',
    productId: 'p1',
    variantId: null,
    storageKey: 'products/p1/1.jpg',
    url: 'https://cdn.test/1.jpg',
    type: 'image',
    mime: 'image/jpeg',
    alt: 'Костюм',
    width: 800,
    height: 600,
    sizeBytes: 12345,
    sort: 0,
    isPrimary: true,
    createdAt: D,
    ...over,
  };
}

describe('toProductListItemDto — фасеты сетки каталога', () => {
  it('берёт пол и цвет из attributes_cache товара', () => {
    const dto = toProductListItemDto(
      row({ attributesCache: { gender: 'Мужской', color: 'Белый' } }),
    );
    expect(dto.gender).toBe('Мужской');
    expect(dto.color).toBe('Белый');
  });

  it('понимает русские коды характеристик (код задаёт контентщик магазина)', () => {
    // Платформа мультитенантна: 'color' и 'цвет' — один и тот же фасет.
    const dto = toProductListItemDto(
      row({ attributesCache: { пол: 'Женский', цвет: 'Графит' } }),
    );
    expect(dto.gender).toBe('Женский');
    expect(dto.color).toBe('Графит');
  });

  it('латинский ключ имеет приоритет над русским при обоих заполненных', () => {
    const dto = toProductListItemDto(
      row({ attributesCache: { color: 'Белый', цвет: 'Чёрный' } }),
    );
    expect(dto.color).toBe('Белый');
  });

  it('отсутствующий/пустой/нестроковый атрибут → ПУСТАЯ СТРОКА, а не undefined', () => {
    const dto = toProductListItemDto(
      // Массив — реальная форма кеша для multi-select характеристики; фасет
      // списка ждёт одну строку и обязан отдать '' вместо неё.
      row({ attributesCache: { gender: '   ', color: ['Белый', 'Чёрный'] } }),
    );
    expect(dto.gender).toBe('');
    expect(dto.color).toBe('');
    const empty = toProductListItemDto(row({ attributesCache: {} }));
    expect(empty.gender).toBe('');
    expect(empty.color).toBe('');
  });

  it('обрезает пробелы вокруг значения фасета', () => {
    const dto = toProductListItemDto(
      row({ attributesCache: { color: '  Белый  ' } }),
    );
    expect(dto.color).toBe('Белый');
  });

  it('прокидывает уже схлопнутые метки размеров из строки списка', () => {
    const dto = toProductListItemDto(row({ sizes: ['48', '50', '52'] }));
    expect(dto.sizes).toEqual(['48', '50', '52']);
  });

  it('товар без вариантов → sizes пустой массив (а не undefined)', () => {
    expect(toProductListItemDto(row()).sizes).toEqual([]);
  });

  it('не утечёт внутренний id/sku/status вместе с фасетами', () => {
    const dto = toProductListItemDto(
      row({ attributesCache: { color: 'Белый' }, sizes: ['48'] }),
    );
    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('sku');
    expect(dto).not.toHaveProperty('status');
    expect(dto).not.toHaveProperty('attributesCache');
  });
});

describe('toMediaDto — привязка фото к варианту', () => {
  it('отдаёт variantId привязанного фото (галерея по выбранному цвету)', () => {
    expect(toMediaDto(media({ variantId: 'v1' })).variantId).toBe('v1');
  });

  it('общее фото товара → variantId = null', () => {
    expect(toMediaDto(media({ variantId: null })).variantId).toBeNull();
  });

  it('не утекают storage_key/mime/размеры/байты и внутренний id', () => {
    const dto = toMediaDto(media({ variantId: 'v1' }));
    expect(Object.keys(dto).sort()).toEqual([
      'alt',
      'isPrimary',
      'type',
      'url',
      'variantId',
    ]);
  });
});
