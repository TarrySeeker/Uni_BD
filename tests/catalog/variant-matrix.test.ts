import { describe, expect, it } from 'vitest';

import {
  matrixCellKey,
  matrixSkuBase,
  parseMatrixList,
  planVariantMatrix,
  type ExistingMatrixVariant,
} from '@/lib/catalog/variant-matrix';
import { VariantMatrixSchema } from '@/lib/catalog/schemas';

// ЮНИТ: раскладка матрицы «цвет × размер» в план изменений вариантов — без БД
// и без React (вся идентичность ячейки приходит снаружи).
//
// ПОЧЕМУ ЭТО ПОКРЫТО ТАК ПОДРОБНО: ошибка раскладки не падает, а молча портит
// каталог — либо плодит дубли вариантов на повторном сохранении формы, либо
// гасит чужие варианты (а у них остатки и заказы). Ни то, ни другое typecheck
// не ловит, и на проде это видно только по расползшемуся списку вариантов.

/** Существующий вариант с дефолтами (в тестах меняем одно-два поля). */
function variant(
  over: Partial<ExistingMatrixVariant> & { id: string },
): ExistingMatrixVariant {
  return { name: '42', colorValueId: null, isActive: true, ...over };
}

describe('parseMatrixList', () => {
  it('режет по запятой/точке с запятой/переводу строки, обрезает пробелы', () => {
    expect(parseMatrixList('42, 44 ;46\n48')).toEqual(['42', '44', '46', '48']);
  });

  it('отбрасывает пустые и схлопывает дубли, сохраняя порядок первого появления', () => {
    expect(parseMatrixList('XL,,S, XL ,M,S')).toEqual(['XL', 'S', 'M']);
  });

  it('пустой ввод → пустой список', () => {
    expect(parseMatrixList('')).toEqual([]);
    expect(parseMatrixList('  ,  ; \n ')).toEqual([]);
  });
});

describe('matrixCellKey', () => {
  it('«без цвета» не сливается с цветом, чей id пуст', () => {
    expect(matrixCellKey(null, '42')).not.toBe(matrixCellKey('', '42'));
  });

  it('лишние пробелы в размере не плодят новую ячейку', () => {
    expect(matrixCellKey('c1', ' 42 ')).toBe(matrixCellKey('c1', '42'));
  });

  it('разные цвета при одном размере — разные ячейки', () => {
    expect(matrixCellKey('c1', '42')).not.toBe(matrixCellKey('c2', '42'));
  });
});

describe('matrixSkuBase', () => {
  it('склеивает цвет и размер в транслите', () => {
    expect(matrixSkuBase('Белый', '42')).toBe('belyy-42');
  });

  it('без цвета — только размер', () => {
    expect(matrixSkuBase(null, 'XL')).toBe('xl');
  });

  it('пустая база заменяется на «variant» (иначе все ретраи sku конфликтуют)', () => {
    // Метка целиком из символов, которые slugify выбрасывает.
    expect(matrixSkuBase(null, '///')).toBe('variant');
  });
});

describe('planVariantMatrix — что создать', () => {
  it('пустой товар: цвета × размеры разворачиваются в полный набор ячеек', () => {
    const plan = planVariantMatrix({
      colors: [
        { valueId: 'c1', value: 'Белый' },
        { valueId: 'c2', value: 'Чёрный' },
      ],
      sizes: ['42', '44'],
      existing: [],
    });

    expect(plan.create).toHaveLength(4);
    expect(plan.keep).toEqual([]);
    expect(plan.activate).toEqual([]);
    expect(plan.deactivate).toEqual([]);
    // Обход — по цветам, внутри цвета по размерам: новые варианты ложатся
    // сгруппированными по цвету (читаемо в списке редактора).
    expect(plan.create.map((c) => [c.colorValueId, c.name])).toEqual([
      ['c1', '42'],
      ['c1', '44'],
      ['c2', '42'],
      ['c2', '44'],
    ]);
  });

  it('name ячейки — МЕТКА РАЗМЕРА, цвет в имя не подмешивается (инвариант 1)', () => {
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing: [],
    });
    // «Белый / 42» рассинхронизировал бы фасет размеров каталога (точное
    // сравнение строк) со списком товаров.
    expect(plan.create[0]!.name).toBe('42');
    expect(plan.create[0]!.colorValue).toBe('Белый');
  });

  it('план отдаёт лишь skuBase, а не готовый sku (инвариант 2)', () => {
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing: [],
    });
    expect(plan.create[0]!.skuBase).toBe('belyy-42');
    expect(plan.create[0]).not.toHaveProperty('sku');
  });

  it('пустая ось цвета = один «бесцветный» прогон по размерам, а не ноль ячеек', () => {
    const plan = planVariantMatrix({
      colors: [],
      sizes: ['S', 'M'],
      existing: [],
    });
    expect(plan.create.map((c) => c.name)).toEqual(['S', 'M']);
    expect(plan.create.every((c) => c.colorValueId === null)).toBe(true);
  });

  it('нумерует sort подряд с nextSort (новые варианты не лезут в начало списка)', () => {
    const plan = planVariantMatrix({
      colors: [],
      sizes: ['S', 'M', 'L'],
      existing: [],
      nextSort: 7,
    });
    expect(plan.create.map((c) => c.sort)).toEqual([7, 8, 9]);
  });

  it('дубли в осях схлопываются: повторный цвет/размер не плодит вторую ячейку', () => {
    const plan = planVariantMatrix({
      colors: [
        { valueId: 'c1', value: 'Белый' },
        { valueId: 'c1', value: 'Белый' },
      ],
      sizes: ['42', ' 42 ', '44'],
      existing: [],
    });
    expect(plan.create.map((c) => c.name)).toEqual(['42', '44']);
  });
});

describe('planVariantMatrix — что НЕ создавать повторно', () => {
  it('существующая активная ячейка уходит в keep, а не в create (идемпотентность)', () => {
    const existing = [variant({ id: 'v1', name: '42', colorValueId: 'c1' })];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
    });
    // Повторное сохранение формы обязано быть no-op: иначе каждое нажатие
    // «Применить» удваивало бы варианты товара.
    expect(plan.create).toEqual([]);
    expect(plan.keep).toEqual(['v1']);
  });

  it('сопоставление идёт по id цвета + имени, лишние пробелы в имени не мешают', () => {
    const existing = [variant({ id: 'v1', name: ' 42 ', colorValueId: 'c1' })];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
    });
    expect(plan.create).toEqual([]);
    expect(plan.keep).toEqual(['v1']);
  });

  it('тот же размер под ДРУГИМ цветом — отдельная ячейка (цвет входит в ключ)', () => {
    const existing = [variant({ id: 'v1', name: '42', colorValueId: 'c1' })];
    const plan = planVariantMatrix({
      colors: [
        { valueId: 'c1', value: 'Белый' },
        { valueId: 'c2', value: 'Чёрный' },
      ],
      sizes: ['42'],
      existing,
    });
    expect(plan.keep).toEqual(['v1']);
    expect(plan.create.map((c) => [c.colorValueId, c.name])).toEqual([
      ['c2', '42'],
    ]);
  });

  it('вариант БЕЗ цвета не закрывает цветную ячейку', () => {
    const existing = [variant({ id: 'v1', name: '42', colorValueId: null })];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
    });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.colorValueId).toBe('c1');
    // Бесцветный вариант в матрицу не попал — и без явного флага не гасится.
    expect(plan.keep).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it('несколько исторических вариантов на одну ячейку — все сохраняются, дубль не создаётся', () => {
    const existing = [
      variant({ id: 'v1', name: '42', colorValueId: 'c1' }),
      variant({ id: 'v2', name: '42', colorValueId: 'c1' }),
    ];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
    });
    // Гасить «лишний» дубль молча нельзя: у него могут быть остатки и заказы.
    expect(plan.create).toEqual([]);
    expect(plan.keep).toEqual(['v1', 'v2']);
    expect(plan.deactivate).toEqual([]);
  });
});

describe('planVariantMatrix — включение и гашение', () => {
  it('выключенная ячейка матрицы идёт в activate, а не создаётся заново', () => {
    const existing = [
      variant({ id: 'v1', name: '42', colorValueId: 'c1', isActive: false }),
    ];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
    });
    expect(plan.create).toEqual([]);
    expect(plan.activate).toEqual(['v1']);
    expect(plan.keep).toEqual([]);
  });

  it('по умолчанию варианты ВНЕ матрицы не гасятся (редактор ведёт её частично)', () => {
    const existing = [variant({ id: 'v9', name: '60', colorValueId: 'c1' })];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
    });
    expect(plan.deactivate).toEqual([]);
  });

  it('deactivateMissing=true гасит активные варианты вне матрицы', () => {
    const existing = [
      variant({ id: 'v1', name: '42', colorValueId: 'c1' }),
      variant({ id: 'v9', name: '60', colorValueId: 'c1' }),
    ];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
      deactivateMissing: true,
    });
    expect(plan.keep).toEqual(['v1']);
    expect(plan.deactivate).toEqual(['v9']);
  });

  it('уже выключенный лишний вариант второй раз не трогается (нет шума в аудите)', () => {
    const existing = [
      variant({ id: 'v9', name: '60', colorValueId: 'c1', isActive: false }),
    ];
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: ['42'],
      existing,
      deactivateMissing: true,
    });
    expect(plan.deactivate).toEqual([]);
  });

  it('план НИКОГДА не содержит удалений (order_items хранят снимок варианта)', () => {
    const plan = planVariantMatrix({
      colors: [],
      sizes: ['42'],
      existing: [variant({ id: 'v9', name: '60' })],
      deactivateMissing: true,
    });
    expect(Object.keys(plan).sort()).toEqual([
      'activate',
      'create',
      'deactivate',
      'keep',
    ]);
  });
});

describe('planVariantMatrix — пустая ось размера', () => {
  it('пустые размеры → ПУСТОЙ план, а не «погасить всё»', () => {
    const existing = [
      variant({ id: 'v1', name: '42', colorValueId: 'c1' }),
      variant({ id: 'v2', name: '44', colorValueId: 'c1' }),
    ];
    // Открытие формы с незаполненной осью не должно стоить товару вариантов —
    // даже с включённым флагом гашения.
    const plan = planVariantMatrix({
      colors: [{ valueId: 'c1', value: 'Белый' }],
      sizes: [],
      existing,
      deactivateMissing: true,
    });
    expect(plan).toEqual({
      create: [],
      keep: [],
      activate: [],
      deactivate: [],
    });
  });

  it('ось из одних пробелов равна пустой оси', () => {
    const plan = planVariantMatrix({
      colors: [],
      sizes: ['  ', ''],
      existing: [variant({ id: 'v1' })],
      deactivateMissing: true,
    });
    expect(plan.create).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Контракт входа матрицы (VariantMatrixSchema). Держим здесь, а не в общем
// schemas.test.ts: схема и раскладка — одна фича, и потолок ячеек охраняет
// именно эту транзакцию.
// -----------------------------------------------------------------------------

// UUID версии 4 с корректными variant-битами: Zod 4 проверяет их, а не только форму.
const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

describe('VariantMatrixSchema', () => {
  it('минимальный валидный вход: товар + одна метка размера', () => {
    const res = VariantMatrixSchema.safeParse({
      productId: UUID,
      sizes: ['42'],
    });
    expect(res.success).toBe(true);
    // Пустой список цветов и «не гасить» — безопасные дефолты: матрица
    // вырождается в плоский список размеров и чужих вариантов не трогает.
    expect(res.success && res.data.colors).toEqual([]);
    expect(res.success && res.data.deactivateMissing).toBe(false);
  });

  it('цвета принимаются ТОЛЬКО как uuid значений справочника, без подписи', () => {
    expect(
      VariantMatrixSchema.safeParse({
        productId: UUID,
        colors: [UUID2],
        sizes: ['42'],
      }).success,
    ).toBe(true);
    // Пара {valueId, value} означала бы, что подпись в аудит и артикул придёт
    // от клиента, а не из справочника.
    expect(
      VariantMatrixSchema.safeParse({
        productId: UUID,
        colors: [{ valueId: UUID2, value: 'Белый' }],
        sizes: ['42'],
      }).success,
    ).toBe(false);
  });

  it('пустая ось размера отклоняется схемой (форма не заполнена)', () => {
    expect(
      VariantMatrixSchema.safeParse({ productId: UUID, sizes: [] }).success,
    ).toBe(false);
  });

  it('пустая/пробельная метка размера отклоняется', () => {
    expect(
      VariantMatrixSchema.safeParse({ productId: UUID, sizes: ['  '] }).success,
    ).toBe(false);
  });

  it('обрезает пробелы в метках размера', () => {
    const res = VariantMatrixSchema.safeParse({
      productId: UUID,
      sizes: [' 42 '],
    });
    expect(res.success && res.data.sizes).toEqual(['42']);
  });

  it('потолок в 200 ячеек ограничивает ПРОИЗВЕДЕНИЕ осей, а не их длины', () => {
    const colors = Array.from({ length: 20 }, () => UUID2);
    // 20 × 10 = 200 — на границе, проходит.
    expect(
      VariantMatrixSchema.safeParse({
        productId: UUID,
        colors,
        sizes: Array.from({ length: 10 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(true);
    // 20 × 11 = 220 — вставочный шторм в одной транзакции, отклоняем.
    expect(
      VariantMatrixSchema.safeParse({
        productId: UUID,
        colors,
        sizes: Array.from({ length: 11 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);
  });

  it('без цветов потолок считается по одной «бесцветной» полосе', () => {
    // Иначе 0 × N = 0 проскочило бы любой размер оси размеров.
    expect(
      VariantMatrixSchema.safeParse({
        productId: UUID,
        sizes: Array.from({ length: 64 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(true);
  });

  it('productId обязателен и должен быть uuid', () => {
    expect(VariantMatrixSchema.safeParse({ sizes: ['42'] }).success).toBe(false);
    expect(
      VariantMatrixSchema.safeParse({ productId: 'p1', sizes: ['42'] }).success,
    ).toBe(false);
  });

  it('colorAttributeId необязателен (action сам найдёт справочник «Цвет»)', () => {
    expect(
      VariantMatrixSchema.safeParse({
        productId: UUID,
        colorAttributeId: null,
        sizes: ['42'],
      }).success,
    ).toBe(true);
    expect(
      VariantMatrixSchema.safeParse({
        productId: UUID,
        colorAttributeId: UUID2,
        sizes: ['42'],
      }).success,
    ).toBe(true);
  });
});
