import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { sql, closeSql } from '@/lib/db/client';
import { listProducts } from '@/lib/catalog/repository';

/**
 * ЖИВАЯ НАХОДКА 2026-07-29 (стенд erfgv.website): поиск по каталогу искал ТОЛЬКО
 * по русскому базовому `name` и `sku`, полностью игнорируя `translations`.
 *
 * Проверено на живом API:
 *   q=Платок  -> 100 товаров
 *   q=black   -> 0        (при этом товар `black-horse-silk` на en зовётся
 *   q=kimono  -> 0         «Black Horse silk» и показан на английской главной)
 *   q=Tigre   -> 0
 *
 * То есть для англо- и франкоязычных покупателей — тех, ради кого и делалась
 * локализация, — поиск не работал вовсе: витрина отвечала «Nothing found» на
 * название, которое сама же и показывает.
 *
 * Причина — `lib/catalog/repository.ts`: в WHERE участвовали только `p.name`
 * и `p.sku`. Мультитенантно правильное поведение — искать по базовому имени И
 * по всем переводам, без хардкода списка языков (магазин может включить любой).
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const created: string[] = [];

describe.skipIf(!hasDb)('поиск по каталогу видит переводы', () => {
  afterAll(async () => {
    if (created.length) {
      await sql`DELETE FROM products WHERE id = ANY(${created}::uuid[])`.catch(
        () => undefined,
      );
    }
    await closeSql();
  });

  /** Товар с русским базовым именем и переводами en/fr — как в реальном каталоге. */
  async function makeProduct(suffix: string) {
    const translations = {
      en: { name: `Silk Scarf Horse ${suffix}` },
      fr: { name: `Foulard Cheval ${suffix}` },
    };
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price, translations)
      VALUES (
        ${`search-tr-${suffix}`},
        ${`search-tr-${suffix}`},
        ${`Платок Тестовый ${suffix}`},
        'active',
        1000.00,
        ${sql.json(translations)}
      )
      RETURNING id
    `;
    created.push(row!.id);
    return row!;
  }

  it('находит товар по английскому названию из translations', async () => {
    const suffix = randomUUID().slice(0, 8);
    const product = await makeProduct(suffix);

    const { rows } = await listProducts({
      search: `Silk Scarf Horse ${suffix}`,
      page: 1,
      pageSize: 5,
    });

    expect(rows.map((r) => r.id)).toContain(product.id);
  });

  it('находит товар по французскому названию из translations', async () => {
    const suffix = randomUUID().slice(0, 8);
    const product = await makeProduct(suffix);

    const { rows } = await listProducts({
      search: `Foulard Cheval ${suffix}`,
      page: 1,
      pageSize: 5,
    });

    expect(rows.map((r) => r.id)).toContain(product.id);
  });

  it('поиск по русскому имени и по sku продолжает работать', async () => {
    const suffix = randomUUID().slice(0, 8);
    const product = await makeProduct(suffix);

    const byName = await listProducts({ search: `Платок Тестовый ${suffix}`, page: 1, pageSize: 5 });
    expect(byName.rows.map((r) => r.id)).toContain(product.id);

    const bySku = await listProducts({ search: `search-tr-${suffix}`, page: 1, pageSize: 5 });
    expect(bySku.rows.map((r) => r.id)).toContain(product.id);
  });

  it('чужой запрос не притягивает товар (поиск не стал «находить всё»)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const product = await makeProduct(suffix);

    const { rows } = await listProducts({
      search: `zzz-nothing-matches-${randomUUID().slice(0, 8)}`,
      page: 1,
      pageSize: 5,
    });

    expect(rows.map((r) => r.id)).not.toContain(product.id);
  });
});

/**
 * GUARD без БД: сторожит сам SQL. Нужен потому, что интеграционные тесты выше
 * пропускаются без DATABASE_URL — а в CI проекта БД поднимается не всегда.
 */
describe('GUARD: SQL поиска включает translations', () => {
  const repo = readFileSync(join(process.cwd(), 'lib/catalog/repository.ts'), 'utf8');

  it('условие поиска учитывает переводы, а не только name и sku', () => {
    const whereStart = repo.indexOf('WHERE (${searchTerm}');
    expect(whereStart).toBeGreaterThan(-1);
    // Условие поиска — до начала следующего фильтра (`AND (${f.status`).
    const clause = repo.slice(whereStart, repo.indexOf('AND (${f.status', whereStart));

    expect(clause).toMatch(/translations/);
    // Языки не перечисляем поимённо: магазин может включить любой набор локалей.
    expect(clause).not.toMatch(/->>?\s*'(en|fr)'/);
  });
});
