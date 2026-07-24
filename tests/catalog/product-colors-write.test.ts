import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_MASTER_COLORS,
  MASTER_COLOR_LEGACY_COUNT,
  resolveMasterColors,
} from '@/lib/catalog/master-colors';
import {
  MAX_PRODUCT_COLORS,
  normalizeHex,
  normalizeProductColors,
} from '@/lib/catalog/colors';
import {
  ProductCreateSchema,
  ProductUpdateSchema,
  productColorsSchema,
} from '@/lib/catalog/schemas';
import { catalogSettingsSchema } from '@/lib/settings/schemas';

/**
 * ТЗ владельца п.4 — «выбор цвета из старой админки перенести».
 *
 * Здесь сторожим write-path цветов товара (products.colors, 0050), которого
 * раньше не было: чистые функции нормализации, Zod-контракт (в т.ч. КРИТИЧНЫЙ
 * undefined vs [] в частичном апдейте), биндинг jsonb МАССИВОМ и UI-блок формы.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// =============================================================================
// A1 — справочник мастер-цветов (дефолт платформы + оверрайд магазина).
// =============================================================================
describe('catalog/master-colors — справочник', () => {
  it('дефолт платформы = 13 легаси-позиций, у каждой id/name/валидный hex', () => {
    expect(DEFAULT_MASTER_COLORS).toHaveLength(MASTER_COLOR_LEGACY_COUNT);
    expect(MASTER_COLOR_LEGACY_COUNT).toBe(13);
    for (const c of DEFAULT_MASTER_COLORS) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
    }
    const ids = DEFAULT_MASTER_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('порядок легаси-справочника сохранён (b_master_colors id 1..13)', () => {
    expect(DEFAULT_MASTER_COLORS.map((c) => c.name)).toEqual([
      'Красный', 'Оранжевый', 'Жёлтый', 'Зелёный', 'Голубой', 'Синий',
      'Фиолетовый', 'Белый', 'Чёрный', 'Мультиколор', 'Розовый', 'Серый', 'Бежевый',
    ]);
  });

  it('нет оверрайда магазина → дефолт платформы (мультитенантность: не «цвета carre»)', () => {
    expect(resolveMasterColors(undefined)).toEqual([...DEFAULT_MASTER_COLORS]);
    expect(resolveMasterColors(null)).toEqual([...DEFAULT_MASTER_COLORS]);
    expect(resolveMasterColors([])).toEqual([...DEFAULT_MASTER_COLORS]);
  });

  it('оверрайд магазина ПОЛНОСТЬЮ заменяет справочник (а не дополняет)', () => {
    const own = resolveMasterColors([{ id: 'neon', name: 'Неон', hex: '#CCFF00' }]);
    expect(own).toEqual([{ id: 'neon', name: 'Неон', hex: '#ccff00' }]);
  });

  it('битые записи оверрайда отбрасываются; всё битое → дефолт', () => {
    const mixed = resolveMasterColors([
      { id: 'ok', name: 'Ок', hex: '#abc' },
      { id: '', name: 'без id', hex: '#000000' } as never,
      { id: 'bad', name: 'кривой hex', hex: 'красный' } as never,
    ]);
    expect(mixed).toEqual([{ id: 'ok', name: 'Ок', hex: '#aabbcc' }]);
    expect(resolveMasterColors([{ id: 'x', name: 'y', hex: 'нет' } as never])).toEqual([
      ...DEFAULT_MASTER_COLORS,
    ]);
  });

  it('оверрайд живёт в shop_settings.catalog.masterColors (существующий ключ настроек)', () => {
    const parsed = catalogSettingsSchema.parse({
      newProductDays: 30,
      masterColors: [{ id: 'neon', name: 'Неон', hex: '#ccff00' }],
    });
    expect(parsed.masterColors).toEqual([{ id: 'neon', name: 'Неон', hex: '#ccff00' }]);
    // Обратная совместимость: настройка опциональна.
    expect(catalogSettingsSchema.parse({}).masterColors).toBeUndefined();
  });
});

// =============================================================================
// A2 — чистые функции нормализации payload цветов.
// =============================================================================
describe('catalog/colors — normalizeHex (юнит)', () => {
  it('короткая форма #abc → #aabbcc', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
  });

  it('без решётки: abc / AABBCC → #aabbcc', () => {
    expect(normalizeHex('abc')).toBe('#aabbcc');
    expect(normalizeHex('AABBCC')).toBe('#aabbcc');
  });

  it('регистр приводится к нижнему, пробелы обрезаются', () => {
    expect(normalizeHex('  #FF00Aa ')).toBe('#ff00aa');
  });

  it('мусор → null', () => {
    for (const bad of ['red', '#ff', '#ggghhh', '#1234567', '', '   ', null, 42, undefined]) {
      expect(normalizeHex(bad as never)).toBeNull();
    }
  });
});

describe('catalog/colors — normalizeProductColors (юнит)', () => {
  it('нормализует hex и сохраняет порядок «основной → дополнительный»', () => {
    expect(
      normalizeProductColors([
        { hex: 'FF0000', name: ' Красный ' },
        { hex: '#00F', name: 'Синий' },
      ]),
    ).toEqual([
      { hex: '#ff0000', name: 'Красный' },
      { hex: '#0000ff', name: 'Синий' },
    ]);
  });

  it('запись без валидного hex отбрасывается (нечего красить), пустое name допустимо', () => {
    expect(
      normalizeProductColors([
        { name: 'без цвета' },
        { hex: 'не-цвет', name: 'мусор' },
        { hex: '#123456' },
      ]),
    ).toEqual([{ hex: '#123456', name: '' }]);
  });

  it('обрезает до 2 записей (легаси: основной + дополнительный)', () => {
    expect(MAX_PRODUCT_COLORS).toBe(2);
    const out = normalizeProductColors([
      { hex: '#111111', name: 'a' },
      { hex: '#222222', name: 'b' },
      { hex: '#333333', name: 'c' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.hex)).toEqual(['#111111', '#222222']);
  });

  it('не-массив/мусор → []', () => {
    expect(normalizeProductColors(null)).toEqual([]);
    expect(normalizeProductColors('#fff')).toEqual([]);
    expect(normalizeProductColors({ hex: '#fff' })).toEqual([]);
  });
});

// =============================================================================
// A3 — Zod-контракт.
// =============================================================================
describe('catalog/schemas — colors', () => {
  it('валидная пара {hex,name} проходит, hex канонизируется в #rrggbb', () => {
    expect(productColorsSchema.parse([{ hex: '#ABC', name: 'Красный' }])).toEqual([
      { hex: '#aabbcc', name: 'Красный' },
    ]);
  });

  it('name необязателен → ""', () => {
    expect(productColorsSchema.parse([{ hex: '#ff0000' }])).toEqual([
      { hex: '#ff0000', name: '' },
    ]);
  });

  it('3 цвета → отказ (легаси: ровно основной + дополнительный)', () => {
    const r = productColorsSchema.safeParse([
      { hex: '#111111' }, { hex: '#222222' }, { hex: '#333333' },
    ]);
    expect(r.success).toBe(false);
  });

  it("'red' → отказ, '#ff' → отказ", () => {
    expect(productColorsSchema.safeParse([{ hex: 'red' }]).success).toBe(false);
    expect(productColorsSchema.safeParse([{ hex: '#ff' }]).success).toBe(false);
  });

  it('create: colors опционально; переданное — валидируется', () => {
    const ok = ProductCreateSchema.safeParse({ name: 'Платок' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.colors).toBeUndefined();

    const withColors = ProductCreateSchema.parse({
      name: 'Платок',
      colors: [{ hex: '#FF0000', name: 'Красный' }],
    });
    expect(withColors.colors).toEqual([{ hex: '#ff0000', name: 'Красный' }]);
    expect(
      ProductCreateSchema.safeParse({ name: 'Платок', colors: [{ hex: 'nope' }] }).success,
    ).toBe(false);
  });

  const ID = '11111111-1111-4111-8111-111111111111';

  it('🔴 КОНТРАКТ update: colors отсутствует → undefined («не трогать»)', () => {
    const parsed = ProductUpdateSchema.parse({ id: ID, status: 'active' });
    expect('colors' in parsed ? parsed.colors : undefined).toBeUndefined();
  });

  it('🔴 КОНТРАКТ update: colors=[] проходит и остаётся [] («очистить»)', () => {
    const parsed = ProductUpdateSchema.parse({ id: ID, colors: [] });
    expect(parsed.colors).toEqual([]);
  });

  it('update: частичный апдейт без colors не превращает их в [] (иначе стёрли бы ETL-цвета)', () => {
    const parsed = ProductUpdateSchema.parse({ id: ID, basePrice: '100' });
    expect(parsed.colors).not.toEqual([]);
    expect(parsed.colors).toBeUndefined();
  });
});

// =============================================================================
// A3/A5 — guard-тесты источников (write-path и ETL пишут jsonb МАССИВОМ).
// =============================================================================
describe('guard — биндинг products.colors в actions', () => {
  const src = read('lib/catalog/actions.ts');

  it('updateProduct различает undefined и [] через CASE WHEN data.colors !== undefined', () => {
    expect(src).toMatch(
      /colors\s*=\s*CASE WHEN \$\{data\.colors !== undefined\}/,
    );
    // Антипаттерн: COALESCE стёр бы разницу между [] и undefined только частично,
    // а безусловная запись — стёрла бы ETL-цвета при любом частичном апдейте.
    expect(src).not.toMatch(/colors\s*=\s*COALESCE/);
    expect(src).not.toMatch(/colors\s*=\s*\$\{sql\.json/);
  });

  it('цвета уходят в БД как jsonb-МАССИВ (sql.json), а не как JSON-строка', () => {
    // Есть правильный вызов…
    expect(src).toMatch(/sql\.json\((?:[^)]*)colors/);
    // …и запрещён антипаттерн JSON.stringify для colors (баг ETL, замаскированный asColors).
    expect(src).not.toMatch(/JSON\.stringify\([^)]*colors/i);
  });

  it('createProduct пишет колонку colors', () => {
    expect(src).toMatch(/INSERT INTO products \([\s\S]*?colors/);
  });
});

describe('guard — scripts/load-product-colors.mjs (A5)', () => {
  const src = read('scripts/load-product-colors.mjs');

  it('UPDATE биндит массив через sql.json (иначе jsonb_typeof = string)', () => {
    expect(src).toMatch(/SET colors = \$\{sql\.json\(colors\)\}/);
  });

  it('антипаттерн JSON.stringify(colors) вырезан', () => {
    expect(src).not.toMatch(/JSON\.stringify\(colors\)/);
  });

  it('есть пост-проверка jsonb_typeof (следующий прогон ETL не зальёт строки незаметно)', () => {
    expect(src).toMatch(/jsonb_typeof/);
  });
});

// =============================================================================
// A4 — guard по вёрстке ProductForm (React-тестов в проекте нет).
// =============================================================================
describe('guard — блок «Цвета» в ProductForm.tsx', () => {
  const src = read('app/admin/(panel)/catalog/_components/ProductForm.tsx');

  it('есть вкладка/секция цветов с легаси-заголовками', () => {
    // Заголовки слотов переведены на next-intl: компонент подставляет их по
    // ключам, а сами легаси-подписи живут в messages/ru.json (дефолтный язык).
    expect(src).toMatch(/catalog\.product\.colors\.slotPrimary/);
    expect(src).toMatch(/catalog\.product\.colors\.slotSecondary/);
    const ru = read('messages/ru.json');
    expect(ru).toContain('Основной цвет');
    expect(ru).toContain('Дополнительный цвет');
  });

  it('есть колорпикер input type="color" И ручной ввод кода цвета', () => {
    expect(src).toMatch(/type="color"/);
    // Ручной ввод: текстовое поле с placeholder-hex рядом с пикером.
    expect(src).toMatch(/placeholder="#rrggbb"/);
  });

  it('есть селект мастер-цвета из справочника (а не хардкод списка цветов в JSX)', () => {
    expect(src).toMatch(/masterColors\.map\(/);
    expect(src).toMatch(/from '@\/lib\/catalog\/master-colors'/);
    // Никакого хардкода «Красный/Синий» прямо в форме (мультитенантность).
    expect(src).not.toContain('Мультиколор');
  });

  it('payload цветов собирается чистой функцией, а не инлайном', () => {
    expect(src).toMatch(/normalizeProductColors\(/);
    expect(src).toMatch(/from '@\/lib\/catalog\/colors'/);
  });

  it('🔴 форма шлёт colors в ОБОИХ режимах — иначе сохранение стирало бы цвета', () => {
    expect(src).toMatch(/colors:\s*normalizeProductColors/);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД: jsonb_typeof='array' и контракт undefined vs [].
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)(
  'catalog — write-path colors (интеграция, нужна БД)',
  () => {
    let sql: typeof import('@/lib/db/client').sql;
    let closeSql: typeof import('@/lib/db/client').closeSql;
    const tag = 'cw-' + Math.random().toString(36).slice(2, 8);
    const ids: string[] = [];

    beforeAll(async () => {
      const db = await import('@/lib/db/client');
      sql = db.sql;
      closeSql = db.closeSql;
    });

    afterAll(async () => {
      for (const id of ids) await sql`DELETE FROM products WHERE id = ${id}`;
      if (closeSql) await closeSql();
    });

    it('sql.json(...) кладёт jsonb МАССИВ (jsonb_typeof=array), JSON-строка — нет', async () => {
      const colors = [{ hex: '#ff0000', name: 'Красный' }];
      const rows = await sql<{ id: string }[]>`
        INSERT INTO products (sku, slug, name, colors)
        VALUES (${`${tag}-s`}, ${`${tag}-l`}, ${'Товар'}, ${sql.json(colors)})
        RETURNING id
      `;
      ids.push(rows[0]!.id);
      const t = await sql<{ t: string }[]>`
        SELECT jsonb_typeof(colors) AS t FROM products WHERE id = ${rows[0]!.id}
      `;
      expect(t[0]!.t).toBe('array');
    });

    it('CASE WHEN provided: undefined не трогает colors, [] очищает', async () => {
      const colors = [{ hex: '#00ff00', name: 'Зелёный' }];
      const rows = await sql<{ id: string }[]>`
        INSERT INTO products (sku, slug, name, colors)
        VALUES (${`${tag}-s2`}, ${`${tag}-l2`}, ${'Товар2'}, ${sql.json(colors)})
        RETURNING id
      `;
      const id = rows[0]!.id;
      ids.push(id);

      // «Не трогать» (provided=false) — цвета на месте.
      await sql`
        UPDATE products SET
          colors = CASE WHEN ${false} THEN ${sql.json([])}::jsonb ELSE colors END,
          updated_at = now()
        WHERE id = ${id}
      `;
      const kept = await sql<{ colors: unknown }[]>`
        SELECT colors FROM products WHERE id = ${id}
      `;
      expect(kept[0]!.colors).toEqual(colors);

      // «Очистить» (provided=true, []) — пусто, но всё ещё массив.
      await sql`
        UPDATE products SET
          colors = CASE WHEN ${true} THEN ${sql.json([])}::jsonb ELSE colors END,
          updated_at = now()
        WHERE id = ${id}
      `;
      const cleared = await sql<{ colors: unknown; t: string }[]>`
        SELECT colors, jsonb_typeof(colors) AS t FROM products WHERE id = ${id}
      `;
      expect(cleared[0]!.colors).toEqual([]);
      expect(cleared[0]!.t).toBe('array');
    });
  },
);
