import { describe, expect, it, vi } from 'vitest';

/**
 * РУЧНОЙ прогон (smoke) C10-1 — НЕ assert-only мок, а ПОВЕДЕНЧЕСКАЯ модель БД:
 * in-memory store, где SELECT реально фильтрует/джойнит строки product_attributes,
 * а UPDATE реально мутирует product_variants.attributes_cache. Затем читаем кеш
 * обратно (round-trip). Цель — увидеть фактический результат работы НАСТОЯЩЕЙ
 * функции на «живых» данных, а не только форму SQL (две проверки: код + ручная).
 */

const Store = vi.hoisted(() => {
  // «БД» в памяти.
  const db = {
    attributes: [] as { id: string; code: string }[],
    attributeValues: [] as { id: string; value: string }[],
    productAttributes: [] as {
      product_id: string;
      variant_id: string | null;
      attribute_id: string;
      value_id: string | null;
      value_text: string | null;
    }[],
    variantCache: new Map<string, Record<string, unknown>>(),
  };

  // Мини-движок: распознаём ровно те 2 запроса, что эмитит функция.
  const sqlMock = vi.fn((strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = Array.from(strings).join('?');
    if (text.includes('FROM product_attributes pa') && text.includes('variant_id = ANY')) {
      const [productId, variantIds] = args as [string, string[]];
      const rows = db.productAttributes
        .filter(
          (pa) =>
            pa.product_id === productId &&
            pa.variant_id !== null &&
            variantIds.includes(pa.variant_id),
        )
        .map((pa) => {
          const attr = db.attributes.find((a) => a.id === pa.attribute_id);
          const av = pa.value_id
            ? db.attributeValues.find((v) => v.id === pa.value_id)
            : undefined;
          // COALESCE(av.value, pa.value_text).
          const value = av ? av.value : pa.value_text;
          return { variant_id: pa.variant_id, code: attr?.code, value };
        });
      return Promise.resolve(rows);
    }
    if (text.includes('UPDATE product_variants') && text.includes('attributes_cache')) {
      // args: [cacheJson, variantId] (sql.json identity).
      const [cache, variantId] = args as [Record<string, unknown>, string];
      db.variantCache.set(variantId, cache);
      return Promise.resolve([]);
    }
    throw new Error(`smoke: неожиданный SQL: ${text}`);
  });
  (sqlMock as unknown as { json: unknown }).json = (v: unknown) => v;
  return { db, sqlMock };
});

vi.mock('@/lib/db/client', () => ({ sql: Store.sqlMock }));

import { rebuildVariantAttributesCache } from '@/lib/catalog/cache';

const PID = 'p-1';
const A_COLOR = 'a-color';
const A_SIZE = 'a-size';
const V_RED = 'v-red';
const V_BLUE = 'v-blue';
const VAR_A = 'var-a';
const VAR_B = 'var-b';
const VAR_C = 'var-c';

describe('C10-1 SMOKE — round-trip на поведенческой БД', () => {
  it('живой прогон: запись по EAV → чтение product_variants.attributes_cache', async () => {
    const { db } = Store;
    db.attributes.push({ id: A_COLOR, code: 'color' }, { id: A_SIZE, code: 'size' });
    db.attributeValues.push(
      { id: V_RED, value: 'Красный' },
      { id: V_BLUE, value: 'Синий' },
    );
    // VAR_A: color=Красный (select). VAR_B: color=Синий (select) + size=M (text).
    // VAR_C: ранее имел кеш — теперь характеристик нет (должен очиститься).
    db.productAttributes.push(
      { product_id: PID, variant_id: VAR_A, attribute_id: A_COLOR, value_id: V_RED, value_text: null },
      { product_id: PID, variant_id: VAR_B, attribute_id: A_COLOR, value_id: V_BLUE, value_text: null },
      { product_id: PID, variant_id: VAR_B, attribute_id: A_SIZE, value_id: null, value_text: 'M' },
    );
    db.variantCache.set(VAR_C, { color: 'СТАРЫЙ-СТЕЙЛ' });

    const result = await rebuildVariantAttributesCache(PID, [VAR_A, VAR_B, VAR_C]);

    // Читаем «из БД» обратно.
    const readBack = {
      [VAR_A]: db.variantCache.get(VAR_A),
      [VAR_B]: db.variantCache.get(VAR_B),
      [VAR_C]: db.variantCache.get(VAR_C),
    };
    console.log('C10-1 SMOKE — кеш вариантов после пересбора:', JSON.stringify(readBack));

    expect(readBack[VAR_A]).toEqual({ color: 'Красный' });
    expect(readBack[VAR_B]).toEqual({ color: 'Синий', size: 'M' });
    // Анти-стейл: VAR_C очищен в {}, а не остался 'СТАРЫЙ-СТЕЙЛ'.
    expect(readBack[VAR_C]).toEqual({});
    expect(result[VAR_C]).toEqual({});
  });
});
