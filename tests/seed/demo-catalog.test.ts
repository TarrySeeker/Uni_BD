import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Тесты пакета П5 (Этап 2) — ОПЦИОНАЛЬНЫЙ seed демо-каталога (docs/05 §1.2, §7 П5).
 *
 * ЮНИТ (всегда зелёные): статически проверяем, что demo-catalog.sql идемпотентен
 *   (ON CONFLICT DO NOTHING), наполняет нужные таблицы каталога, использует
 *   NUMERIC-цены, содержит нейтральные обобщённые данные (без хардкода бренда
 *   конкретного магазина), а init-shop.sh накатывает его ТОЛЬКО под флагом
 *   SEED_DEMO_CATALOG (по умолчанию выключено).
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат демо-каталога не плодит
 *   дублей (требует БД с накатанными миграциями 0005–0010).
 */

const root = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const demoSql = readFileSync(root('db/seed/demo-catalog.sql'), 'utf8');
const initShop = readFileSync(root('scripts/init-shop.sh'), 'utf8');
const envExample = readFileSync(root('.env.example'), 'utf8');

describe('seed/demo-catalog.sql — файл и базовая структура', () => {
  it('файл существует', () => {
    expect(existsSync(root('db/seed/demo-catalog.sql'))).toBe(true);
  });

  it('идемпотентен: каждый INSERT снабжён ON CONFLICT ... DO NOTHING', () => {
    const inserts = (demoSql.match(/INSERT\s+INTO/gi) ?? []).length;
    const conflicts = (demoSql.match(/ON\s+CONFLICT[\s\S]*?DO\s+NOTHING/gi) ?? [])
      .length;
    expect(inserts).toBeGreaterThan(0);
    // Число ON CONFLICT DO NOTHING не меньше числа INSERT — каждый защищён.
    expect(conflicts).toBeGreaterThanOrEqual(inserts);
  });

  it('не использует хардкод-UUID (id генерируются БД, связи — по естественным ключам)', () => {
    // Любой литерал UUID вида xxxxxxxx-xxxx-... — признак хрупкой привязки.
    expect(demoSql).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});

describe('seed/demo-catalog.sql — наполняет таблицы каталога', () => {
  const tables = [
    'categories',
    'products',
    'product_categories',
    'product_variants',
    'attributes',
    'attribute_values',
    'product_attributes',
    'inventory',
  ];

  for (const table of tables) {
    it(`вставляет в таблицу ${table}`, () => {
      const re = new RegExp(`insert\\s+into\\s+${table}\\b`, 'i');
      expect(demoSql).toMatch(re);
    });
  }

  it('строит дерево категорий: корень + подкатегории через parent_id', () => {
    expect(demoSql.toLowerCase()).toContain('parent_id');
    // Минимум корень + 3 подкатегории по стабильным slug.
    expect(demoSql).toContain("'demo-root'");
    expect(demoSql).toContain("'demo-cat-1'");
    expect(demoSql).toContain("'demo-cat-2'");
    expect(demoSql).toContain("'demo-cat-3'");
  });

  it('заводит атрибуты Цвет и Размер со значениями (EAV)', () => {
    expect(demoSql).toContain("'demo-color'");
    expect(demoSql).toContain("'demo-size'");
    expect(demoSql).toContain('Цвет');
    expect(demoSql).toContain('Размер');
  });

  it('создаёт несколько товаров (3–5) со статусом active', () => {
    const skus = demoSql.match(/'DEMO-00\d'/g) ?? [];
    expect(skus.length).toBeGreaterThanOrEqual(3);
    expect(demoSql).toContain("'active'");
  });

  it('создаёт варианты товаров', () => {
    expect(demoSql).toMatch(/'DEMO-00\d-[A-Z-]+'/);
  });
});

describe('seed/demo-catalog.sql — деньги и типы', () => {
  it('цены заданы как NUMERIC-литералы с дробной частью', () => {
    // Базовые цены товаров вида 1000.00, 1990.00 и т.п.
    expect(demoSql).toMatch(/\b\d+\.\d{2}\b/);
  });

  it('базовая цена попадает в колонку base_price', () => {
    expect(demoSql.toLowerCase()).toContain('base_price');
  });

  it('остатки — целые quantity в inventory', () => {
    expect(demoSql.toLowerCase()).toContain('quantity');
  });
});

describe('seed/demo-catalog.sql — универсальность (нет бренда магазина)', () => {
  it('использует обобщённые нейтральные имена (Демо/Образец)', () => {
    expect(demoSql).toContain('Демо-категория');
    expect(demoSql).toContain('Образец товара');
  });

  it('не содержит названий конкретных торговых марок/брендов', () => {
    // Список популярных брендов/нишевых маркеров, которых НЕ должно быть в
    // нейтральном демо-каталоге универсальной платформы.
    const forbidden = [
      'Apple',
      'iPhone',
      'Samsung',
      'Nike',
      'Adidas',
      'Xiaomi',
      'Sony',
      'Zara',
      'IKEA',
      'Gucci',
    ];
    const lower = demoSql.toLowerCase();
    for (const brand of forbidden) {
      expect(lower, `демо-каталог не должен ссылаться на бренд ${brand}`).not.toContain(
        brand.toLowerCase(),
      );
    }
  });
});

describe('scripts/init-shop.sh — условный гейт демо-каталога', () => {
  it('содержит условие по переменной SEED_DEMO_CATALOG', () => {
    expect(initShop).toContain('SEED_DEMO_CATALOG');
  });

  it('накатывает demo-catalog.sql через psql', () => {
    expect(initShop).toContain('demo-catalog.sql');
    expect(initShop).toMatch(/psql[\s\S]*demo-catalog\.sql|DEMO_CATALOG_SQL/);
  });

  it('демо отделено от обязательного seed (по умолчанию пропускается)', () => {
    // Должна быть ветка-пропуск, когда флаг не задан/false.
    expect(initShop.toLowerCase()).toMatch(/пропущ|skip/);
  });
});

describe('.env.example — переменная SEED_DEMO_CATALOG', () => {
  it('документирует SEED_DEMO_CATALOG со значением по умолчанию false', () => {
    expect(envExample).toMatch(/SEED_DEMO_CATALOG\s*=\s*false/);
  });
});

// ---------------------------------------------------------------------------
// Интеграция: двойной накат демо-каталога не плодит дублей.
// Требует БД с накатанными миграциями 0005–0010 (схема каталога).
// ---------------------------------------------------------------------------
const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('demo-catalog (интеграция, требует DATABASE_URL)', () => {
  let sql: import('postgres').Sql;

  beforeAll(async () => {
    const postgres = (await import('postgres')).default;
    sql = postgres(DB_URL as string);
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('двойной накат demo-catalog.sql не плодит дублей', async () => {
    await sql.unsafe(demoSql);
    await sql.unsafe(demoSql);

    const cats = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM categories WHERE slug LIKE 'demo-%'`;
    const prods = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM products WHERE sku LIKE 'DEMO-%'`;
    const vars = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM product_variants WHERE sku LIKE 'DEMO-%'`;

    // 1 корень + 3 подкатегории; 4 товара; 5 вариантов — стабильно после повтора.
    expect(cats[0].n).toBe(4);
    expect(prods[0].n).toBe(4);
    expect(vars[0].n).toBe(5);
  });
});
