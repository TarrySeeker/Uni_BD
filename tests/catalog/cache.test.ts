import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ЮНИТ-тесты презентационного кеша характеристик (lib/catalog/cache.ts) — БЕЗ БД.
 *
 * Фокус — C10-1 (цикл 10): rebuildVariantAttributesCache пересобирает
 * product_variants.attributes_cache из product_attributes (variant-уровень EAV).
 * До фикса этот кеш не писал НИКТО → витрина (toVariantDto) отдавала стейл/пустые
 * атрибуты вариантов. Регрессом покрываем и rebuildProductAttributesCache (товар-уровень).
 *
 * `sql` мокается tagged-template-спаем: пишет {strings,args} каждого вызова и
 * снимает ответ из очереди по подстроке (match). sql.json — identity-обёртка.
 */

const H = vi.hoisted(() => {
  interface SqlCall {
    text: string;
    strings: string[];
    args: unknown[];
  }
  interface QueuedResult {
    match: string;
    rows?: unknown[];
    times?: number;
  }
  const state = {
    calls: [] as SqlCall[],
    responses: [] as QueuedResult[],
  };
  function templateText(strings: TemplateStringsArray | string[]): string {
    return Array.from(strings).join('?');
  }
  const sqlMock = vi.fn((strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = templateText(strings);
    state.calls.push({ text, strings: Array.from(strings), args });
    for (const r of state.responses) {
      if (text.includes(r.match)) {
        if (typeof r.times === 'number') {
          if (r.times <= 0) continue;
          r.times -= 1;
        }
        return Promise.resolve(r.rows ?? []);
      }
    }
    return Promise.resolve([]);
  });
  (sqlMock as unknown as { json: unknown }).json = (v: unknown) => v;
  return { state, sqlMock };
});

vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));

import {
  buildAttributesCache,
  rebuildVariantAttributesCache,
} from '@/lib/catalog/cache';

const PID = '11111111-1111-4111-8111-111111111111';
const VAR_A = '22222222-2222-4222-8222-222222222222';
const VAR_B = '33333333-3333-4333-8333-333333333333';
const VAR_C = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  H.state.calls = [];
  H.state.responses = [];
  H.sqlMock.mockClear();
});

function selectRows(rows: unknown[]) {
  // SELECT в rebuildVariantAttributesCache фильтрует по variant_id = ANY.
  H.state.responses.push({ match: 'variant_id = ANY', rows });
}

function variantUpdates() {
  return H.state.calls.filter((c) =>
    c.text.includes('UPDATE product_variants') &&
    c.text.includes('attributes_cache'),
  );
}

/** Аргумент-кеш и id варианта из одного UPDATE-вызова. */
function updateFor(variantId: string) {
  return variantUpdates().find((c) => c.args.includes(variantId));
}

describe('buildAttributesCache (чистая)', () => {
  it('одно значение на код → скаляр; несколько → массив', () => {
    expect(
      buildAttributesCache([
        { code: 'color', value: 'Красный' },
        { code: 'size', value: 'M' },
      ]),
    ).toEqual({ color: 'Красный', size: 'M' });
    expect(
      buildAttributesCache([
        { code: 'color', value: 'Красный' },
        { code: 'color', value: 'Синий' },
      ]),
    ).toEqual({ color: ['Красный', 'Синий'] });
  });
});

describe('C10-1 — rebuildVariantAttributesCache', () => {
  it('пишет product_variants.attributes_cache КАЖДОМУ переданному варианту по его EAV-строкам', async () => {
    selectRows([
      { variant_id: VAR_A, code: 'color', value: 'Красный' },
      { variant_id: VAR_B, code: 'color', value: 'Синий' },
      { variant_id: VAR_B, code: 'size', value: 'M' },
    ]);

    const result = await rebuildVariantAttributesCache(PID, [VAR_A, VAR_B]);

    // По одному UPDATE на вариант.
    expect(variantUpdates()).toHaveLength(2);
    // VAR_A → {color:'Красный'}; VAR_B → {color:'Синий', size:'M'}.
    expect(updateFor(VAR_A)!.args).toContainEqual({ color: 'Красный' });
    expect(updateFor(VAR_B)!.args).toContainEqual({ color: 'Синий', size: 'M' });
    // Возврат — map variantId → кеш.
    expect(result[VAR_A]).toEqual({ color: 'Красный' });
    expect(result[VAR_B]).toEqual({ color: 'Синий', size: 'M' });
  });

  it('вариант без EAV-строк → кеш стирается в {} (анти-стейл), а не остаётся прежним', async () => {
    // VAR_C передан, но в выборке его строк нет → должен получить пустой {}.
    selectRows([{ variant_id: VAR_A, code: 'color', value: 'Красный' }]);

    const result = await rebuildVariantAttributesCache(PID, [VAR_A, VAR_C]);

    expect(updateFor(VAR_C)).toBeDefined();
    expect(updateFor(VAR_C)!.args).toContainEqual({});
    expect(result[VAR_C]).toEqual({});
  });

  it('несколько значений одного кода у варианта → массив', async () => {
    selectRows([
      { variant_id: VAR_A, code: 'color', value: 'Красный' },
      { variant_id: VAR_A, code: 'color', value: 'Синий' },
    ]);
    const result = await rebuildVariantAttributesCache(PID, [VAR_A]);
    expect(result[VAR_A]).toEqual({ color: ['Красный', 'Синий'] });
  });

  it('SELECT фильтрует по product_id И variant_id = ANY (только переданные варианты)', async () => {
    selectRows([]);
    await rebuildVariantAttributesCache(PID, [VAR_A]);
    const sel = H.state.calls.find((c) => c.text.includes('variant_id = ANY'));
    expect(sel, 'должен быть SELECT по variant_id = ANY').toBeDefined();
    expect(sel!.text).toContain('product_id');
    // productId и список вариантов — в аргументах.
    const flat = sel!.args.flatMap((a) => (Array.isArray(a) ? a : [a]));
    expect(flat).toContain(PID);
    expect(flat).toContain(VAR_A);
  });

  it('пустой список вариантов → ни одного запроса, возврат {}', async () => {
    const result = await rebuildVariantAttributesCache(PID, []);
    expect(result).toEqual({});
    expect(H.state.calls).toHaveLength(0);
  });
});
