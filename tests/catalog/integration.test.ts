import { afterAll, describe, expect, it } from 'vitest';

import { sql, closeSql } from '@/lib/db/client';
import {
  listProducts,
  categorySubtreeIds,
  getProductById,
  getCategoryTree,
  listInventory,
  listBrands,
  getBrandById,
  getBrandBySlug,
} from '@/lib/catalog/repository';
import { rebuildProductAttributesCache } from '@/lib/catalog/cache';
import { toCategoryTreeDto } from '@/lib/storefront/dto';
import { getActiveCategoryIdBySlug } from '@/lib/storefront/queries';

// ИНТЕГРАЦИЯ: требует реальную БД с накатанными миграциями 0005–0010.
// Локально (без DATABASE_URL) — пропускается. Сети/Next не требует: только sql.
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('каталог — интеграция (репозиторий + sql)', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('createProduct → getProductById возвращает товар со связями', async () => {
    const suffix = Date.now().toString(36);
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${'it-sku-' + suffix}, ${'it-slug-' + suffix}, 'Интеграционный товар', 'active', '100.00')
      RETURNING id
    `;
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity)
      VALUES (${id}, NULL, 'main', 7)
    `;

    const detail = await getProductById(id);
    expect(detail).not.toBeNull();
    expect(detail!.sku).toBe('it-sku-' + suffix);
    expect(detail!.basePrice).toBe('100.00');
    expect(detail!.inventory.length).toBe(1);
    expect(detail!.inventory[0]!.quantity).toBe(7);

    const inv = await listInventory(id);
    expect(inv[0]!.quantity).toBe(7);

    // cleanup
    await sql`DELETE FROM products WHERE id = ${id}`;
  });

  it('listProducts фильтрует по поиску и пагинирует', async () => {
    const { rows, total } = await listProducts({ page: 1, pageSize: 5 });
    expect(Array.isArray(rows)).toBe(true);
    expect(typeof total).toBe('number');
  });

  it('getCategoryTree собирает дерево', async () => {
    const suffix = Date.now().toString(36);
    const [{ id: parent }] = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name) VALUES (${'it-parent-' + suffix}, 'Родитель')
      RETURNING id
    `;
    const [{ id: child }] = await sql<{ id: string }[]>`
      INSERT INTO categories (parent_id, slug, name)
      VALUES (${parent}, ${'it-child-' + suffix}, 'Ребёнок')
      RETURNING id
    `;

    const tree = await getCategoryTree();
    const parentNode = findNode(tree, parent);
    expect(parentNode).toBeTruthy();
    expect(parentNode!.children.some((c: { id: string }) => c.id === child)).toBe(true);

    // cleanup (child first из-за RESTRICT)
    await sql`DELETE FROM categories WHERE id = ${child}`;
    await sql`DELETE FROM categories WHERE id = ${parent}`;
  });

  it('rebuildProductAttributesCache собирает кеш из EAV', async () => {
    const suffix = Date.now().toString(36);
    const [{ id: pid }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name) VALUES (${'it-attr-' + suffix}, ${'it-attr-' + suffix}, 'T')
      RETURNING id
    `;
    const [{ id: aid }] = await sql<{ id: string }[]>`
      INSERT INTO attributes (code, name, type) VALUES (${'mat_' + suffix}, 'Материал', 'text')
      RETURNING id
    `;
    await sql`
      INSERT INTO product_attributes (product_id, attribute_id, value_text)
      VALUES (${pid}, ${aid}, 'Хлопок')
    `;
    const cache = await rebuildProductAttributesCache(pid);
    expect(cache['mat_' + suffix]).toBe('Хлопок');

    await sql`DELETE FROM products WHERE id = ${pid}`;
    await sql`DELETE FROM attributes WHERE id = ${aid}`;
  });
});

// ИНТЕГРАЦИЯ: listProducts.availableStock учитывает резерв (доступное = quantity−reserved).
// РЕГРЕСС major: оверселл в списке, когда весь остаток зарезервирован.
describe.skipIf(!hasDb)('каталог — availableStock в списке учитывает резерв', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('товар с полностью зарезервированным остатком: totalStock>0, availableStock=0', async () => {
    const suffix = Date.now().toString(36);
    const sku = 'it-reserved-' + suffix;
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${sku}, ${sku}, 'Зарезервированный', 'active', '100.00')
      RETURNING id
    `;
    // Весь физический остаток зарезервирован: quantity=5, reserved=5 → доступно 0.
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${id}, NULL, 'main', 5, 5)
    `;

    const { rows } = await listProducts({ search: sku, page: 1, pageSize: 5 });
    const found = rows.find((r) => r.id === id);
    expect(found).toBeTruthy();
    expect(found!.totalStock).toBe(5); // физический остаток для админки сохранён
    expect(found!.availableStock).toBe(0); // доступное к продаже — ноль

    await sql`DELETE FROM products WHERE id = ${id}`;
  });

  it('частичный резерв: availableStock = quantity − reserved', async () => {
    const suffix = Date.now().toString(36);
    const sku = 'it-partial-' + suffix;
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${sku}, ${sku}, 'Частичный резерв', 'active', '100.00')
      RETURNING id
    `;
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${id}, NULL, 'a', 5, 2), (${id}, NULL, 'b', 3, 3)
    `;

    const { rows } = await listProducts({ search: sku, page: 1, pageSize: 5 });
    const found = rows.find((r) => r.id === id);
    expect(found!.totalStock).toBe(8); // 5 + 3
    expect(found!.availableStock).toBe(3); // (5−2) + max(3−3,0) = 3 + 0

    await sql`DELETE FROM products WHERE id = ${id}`;
  });
});

// ИНТЕГРАЦИЯ: миграция 0011 (compare_at_price/флаги/бренды). Требует БД с накатанной 0011.
describe.skipIf(!hasDb)('каталог 0011 — цена/флаги/бренды (интеграция)', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('миграция 0011 зарегистрирована и колонки/таблица/индексы на месте', async () => {
    const [mig] = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = '0011'
    `;
    expect(mig?.version).toBe('0011');

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products'
        AND column_name IN ('compare_at_price','is_featured','is_new','brand_id')
    `;
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      'brand_id', 'compare_at_price', 'is_featured', 'is_new',
    ]);

    const [{ count: brandsTbl }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = 'brands'
    `;
    expect(Number(brandsTbl)).toBe(1);

    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('products_featured_idx','products_is_new_idx',
                          'products_has_compare_idx','products_brand_idx',
                          'brands_slug_uniq','brands_active_idx')
    `;
    expect(idx.length).toBe(6);
  });

  it('CHECK compare_at_price >= 0 срабатывает', async () => {
    const suffix = Date.now().toString(36);
    let threw = false;
    try {
      await sql`
        INSERT INTO products (sku, slug, name, base_price, compare_at_price)
        VALUES (${'chk-' + suffix}, ${'chk-' + suffix}, 'X', '10.00', '-1')
      `;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('бренды: CRUD + listBrands/getBrandById/getBrandBySlug', async () => {
    const suffix = Date.now().toString(36);
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO brands (slug, name) VALUES (${'br-' + suffix}, 'Brembo')
      RETURNING id
    `;
    const byId = await getBrandById(id);
    expect(byId?.name).toBe('Brembo');
    const bySlug = await getBrandBySlug('br-' + suffix);
    expect(bySlug?.id).toBe(id);
    const all = await listBrands();
    expect(all.some((b) => b.id === id)).toBe(true);

    await sql`DELETE FROM brands WHERE id = ${id}`;
  });

  it('ON DELETE SET NULL: удаление бренда обнуляет brand_id, товар жив', async () => {
    const suffix = Date.now().toString(36);
    const [{ id: brandId }] = await sql<{ id: string }[]>`
      INSERT INTO brands (slug, name) VALUES (${'brd-' + suffix}, 'Bosch')
      RETURNING id
    `;
    const [{ id: prodId }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, brand_id, compare_at_price, is_featured)
      VALUES (${'p-' + suffix}, ${'p-' + suffix}, 'Деталь', ${brandId}, '150.00', true)
      RETURNING id
    `;

    const withBrand = await getProductById(prodId);
    expect(withBrand?.brandId).toBe(brandId);
    expect(withBrand?.brand?.name).toBe('Bosch');
    expect(withBrand?.isFeatured).toBe(true);
    expect(withBrand?.compareAtPrice).toBe('150.00');

    await sql`DELETE FROM brands WHERE id = ${brandId}`;

    const afterDelete = await getProductById(prodId);
    expect(afterDelete).not.toBeNull(); // товар не удалён
    expect(afterDelete?.brandId).toBeNull(); // brand_id обнулён
    expect(afterDelete?.brand).toBeNull();

    await sql`DELETE FROM products WHERE id = ${prodId}`;
  });

  it('фильтры списка: brandId/onSale (вычисляемый предикат)', async () => {
    const suffix = Date.now().toString(36);
    const [{ id: brandId }] = await sql<{ id: string }[]>`
      INSERT INTO brands (slug, name) VALUES (${'flt-' + suffix}, 'KYB')
      RETURNING id
    `;
    const [{ id: saleId }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price, compare_at_price, brand_id)
      VALUES (${'sale-' + suffix}, ${'sale-' + suffix}, 'Со скидкой', 'active', '100.00', '150.00', ${brandId})
      RETURNING id
    `;
    const [{ id: noSaleId }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price, compare_at_price, brand_id)
      VALUES (${'nosale-' + suffix}, ${'nosale-' + suffix}, 'Без скидки', 'active', '100.00', '80.00', ${brandId})
      RETURNING id
    `;

    const byBrand = await listProducts({ brandId, page: 1, pageSize: 50 });
    const brandIds = byBrand.rows.map((r) => r.id);
    expect(brandIds).toContain(saleId);
    expect(brandIds).toContain(noSaleId);

    const onSale = await listProducts({ brandId, onSale: true, page: 1, pageSize: 50 });
    const saleIds = onSale.rows.map((r) => r.id);
    expect(saleIds).toContain(saleId);
    expect(saleIds).not.toContain(noSaleId);
    const saleRow = onSale.rows.find((r) => r.id === saleId)!;
    expect(saleRow.onSale).toBe(true);
    expect(saleRow.discountPct).toBe(33); // (150-100)/150 = 33.3 → 33

    await sql`DELETE FROM products WHERE id IN (${saleId}, ${noSaleId})`;
    await sql`DELETE FROM brands WHERE id = ${brandId}`;
  });
});

// ИНТЕГРАЦИЯ: рекурсивный фильтр по категории (#9) — товар в ПОДкатегории виден
// при фильтре по РОДИТЕЛЬСКОЙ категории (вкладка верхнего уровня каталога).
describe.skipIf(!hasDb)('каталог — рекурсивный фильтр категории (родитель→потомки)', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('товар в дочерней категории попадает в выборку по родительской', async () => {
    const suffix = Date.now().toString(36);
    const [{ id: parent }] = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name) VALUES (${'rec-parent-' + suffix}, 'Верхняя')
      RETURNING id
    `;
    const [{ id: child }] = await sql<{ id: string }[]>`
      INSERT INTO categories (parent_id, slug, name)
      VALUES (${parent}, ${'rec-child-' + suffix}, 'Дочерняя')
      RETURNING id
    `;
    const [{ id: pid }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${'rec-sku-' + suffix}, ${'rec-slug-' + suffix}, 'Товар в дочерней', 'active', '500.00')
      RETURNING id
    `;
    await sql`
      INSERT INTO product_categories (product_id, category_id, is_primary)
      VALUES (${pid}, ${child}, true)
    `;

    // Поддерево родителя включает обе категории.
    const subtree = await categorySubtreeIds(parent);
    expect(subtree).toContain(parent);
    expect(subtree).toContain(child);

    // Фильтр по РОДИТЕЛЮ отдаёт товар, назначенный только на ребёнка.
    const byParent = await listProducts({ categoryId: parent, page: 1, pageSize: 50 });
    expect(byParent.rows.map((r) => r.id)).toContain(pid);

    // Фильтр по ребёнку — тоже (сам товар).
    const byChild = await listProducts({ categoryId: child, page: 1, pageSize: 50 });
    expect(byChild.rows.map((r) => r.id)).toContain(pid);

    // cleanup (product_categories каскадно по FK; затем товар, дети, родитель).
    await sql`DELETE FROM products WHERE id = ${pid}`;
    await sql`DELETE FROM categories WHERE id = ${child}`;
    await sql`DELETE FROM categories WHERE id = ${parent}`;
  });
});

// ИНТЕГРАЦИЯ (волна 14): listProducts.total_stock/available_stock ИГНОРИРУЮТ
// осиротевшую строку inventory с variant_id IS NULL, когда у товара ЕСТЬ варианты
// (строка уровня товара, заданная ДО добавления вариантов, иначе завышала бы
// наличие — «в наличии», хотя все варианты пусты). Для товара БЕЗ вариантов —
// строка variant_id IS NULL учитывается как обычно.
describe.skipIf(!hasDb)('каталог — осиротевший inventory (variant_id NULL при наличии вариантов)', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('товар С вариантами: строка inventory variant_id IS NULL НЕ учитывается; считаются только варианты', async () => {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const sku = 'it-orphan-' + suffix;
    const [{ id: productId }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${sku}, ${sku}, 'С вариантами', 'active', '100.00')
      RETURNING id
    `;
    // Вариант с собственным остатком (3, из них 1 зарезервирован → доступно 2).
    const [{ id: variantId }] = await sql<{ id: string }[]>`
      INSERT INTO product_variants (product_id, sku, name)
      VALUES (${productId}, ${'itv-' + suffix}, 'M')
      RETURNING id
    `;
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${productId}, ${variantId}, 'main', 3, 1)
    `;
    // ОСИРОТЕВШАЯ строка уровня товара (variant_id IS NULL, заданная до вариантов):
    // её НЕ должны учитывать, иначе total завысится на 50.
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${productId}, NULL, 'main', 50, 0)
    `;

    const { rows } = await listProducts({ search: sku, page: 1, pageSize: 5 });
    const found = rows.find((r) => r.id === productId);
    expect(found).toBeTruthy();
    // Учтён только вариант: total=3 (не 53), available=2 (3−1, без +50 сироты).
    expect(found!.totalStock).toBe(3);
    expect(found!.availableStock).toBe(2);

    await sql`DELETE FROM products WHERE id = ${productId}`;
  });

  it('товар БЕЗ вариантов: строка inventory variant_id IS NULL учитывается', async () => {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const sku = 'it-novar-' + suffix;
    const [{ id: productId }] = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price)
      VALUES (${sku}, ${sku}, 'Без вариантов', 'active', '100.00')
      RETURNING id
    `;
    await sql`
      INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity, reserved)
      VALUES (${productId}, NULL, 'main', 7, 2)
    `;

    const { rows } = await listProducts({ search: sku, page: 1, pageSize: 5 });
    const found = rows.find((r) => r.id === productId);
    expect(found).toBeTruthy();
    expect(found!.totalStock).toBe(7); // строка уровня товара учтена (нет вариантов)
    expect(found!.availableStock).toBe(5); // 7 − 2

    await sql`DELETE FROM products WHERE id = ${productId}`;
  });
});

// ИНТЕГРАЦИЯ: пагинация со СВОБОДНЫМ offset (не кратным pageSize). listProducts
// должен использовать переданный offset как есть — без округления до границы
// страницы. Иначе при листании со свободным offset товары пропускаются/дублятся
// между «страницами» (BUG: minor пагинации публичного API).
describe.skipIf(!hasDb)('каталог — пагинация: свободный offset без пропусков/дублей', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('offset пробрасывается как есть: окна [0..n) и [k..n) согласованы поэлементно', async () => {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const total = 7;
    const ids: string[] = [];
    // Стабильный порядок: фиксируем created_at по возрастанию i, сортируем по нему ASC.
    for (let i = 0; i < total; i++) {
      const sku = `pag-${suffix}-${i}`;
      const [{ id }] = await sql<{ id: string }[]>`
        INSERT INTO products (sku, slug, name, status, base_price, created_at)
        VALUES (${sku}, ${sku}, ${'Пагинация ' + i}, 'active', '100.00',
                ${new Date(Date.now() + i * 1000)})
        RETURNING id
      `;
      ids.push(id);
    }

    // Полное окно (порядок по created_at ASC = порядок вставки).
    const full = await listProducts({
      search: `pag-${suffix}-`,
      page: 1,
      pageSize: total + 5,
      sort: 'created_desc', // дефолтная сортировка списка (created_at DESC)
    });
    const fullIds = full.rows.map((r) => r.id);
    expect(fullIds.length).toBe(total);

    // СВОБОДНЫЙ offset=3, pageSize=10 → суффикс полного окна с 4-го элемента.
    const tail = await listProducts({
      search: `pag-${suffix}-`,
      offset: 3,
      page: 1, // page игнорируется в пользу offset
      pageSize: 10,
      sort: 'created_desc',
    });
    expect(tail.rows.map((r) => r.id)).toEqual(fullIds.slice(3));

    // Несовпадающий с pageSize offset=2, pageSize=3 → строго [2,3,4] полного окна
    // (а не округление вниз до 0). Проверяем отсутствие пропуска/сдвига.
    const window = await listProducts({
      search: `pag-${suffix}-`,
      offset: 2,
      page: 1,
      pageSize: 3,
      sort: 'created_desc',
    });
    expect(window.rows.map((r) => r.id)).toEqual(fullIds.slice(2, 5));

    // Смежные окна со свободным offset не пересекаются и не теряют элементы:
    // [0..2) ∪ [2..5) ∪ [5..7) = всё окно, без дублей.
    const a = await listProducts({ search: `pag-${suffix}-`, offset: 0, page: 1, pageSize: 2, sort: 'created_desc' });
    const b = await listProducts({ search: `pag-${suffix}-`, offset: 2, page: 1, pageSize: 3, sort: 'created_desc' });
    const c = await listProducts({ search: `pag-${suffix}-`, offset: 5, page: 1, pageSize: 3, sort: 'created_desc' });
    const concatenated = [...a.rows, ...b.rows, ...c.rows].map((r) => r.id);
    expect(concatenated).toEqual(fullIds); // без пропусков и без дублей

    await sql`DELETE FROM products WHERE id = ANY(${ids}::uuid[])`;
  });

  it('offset не задан → фолбэк на page (page=2, pageSize=2 = offset 2)', async () => {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sku = `pgf-${suffix}-${i}`;
      const [{ id }] = await sql<{ id: string }[]>`
        INSERT INTO products (sku, slug, name, status, base_price, created_at)
        VALUES (${sku}, ${sku}, ${'Фолбэк ' + i}, 'active', '100.00',
                ${new Date(Date.now() + i * 1000)})
        RETURNING id
      `;
      ids.push(id);
    }

    const full = await listProducts({ search: `pgf-${suffix}-`, page: 1, pageSize: 50, sort: 'created_desc' });
    const fullIds = full.rows.map((r) => r.id);

    // Без offset: page=2, pageSize=2 → элементы [2,3] (как раньше; контракт цел).
    const page2 = await listProducts({ search: `pgf-${suffix}-`, page: 2, pageSize: 2, sort: 'created_desc' });
    expect(page2.rows.map((r) => r.id)).toEqual(fullIds.slice(2, 4));

    await sql`DELETE FROM products WHERE id = ANY(${ids}::uuid[])`;
  });
});

// ИНТЕГРАЦИЯ C4: категорию можно скрыть и снова показать — витрина это отражает.
// Round-trip is_active, на который опирается кнопка «Скрыть/Показать» в
// CategoryManager. Мутацию делаем сырым UPDATE (зеркало updateCategory COALESCE
// is_active — сам Action покрыт guard/schema-юнитами), проверяем согласованность
// дерева (getCategoryTree+toCategoryTreeDto) и резолва категории по slug.
describe.skipIf(!hasDb)('каталог C4 — скрытие/показ категории отражается на витрине', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('активна → видна; is_active=false → скрыта в DTO и getActiveCategoryIdBySlug=null; обратно → снова видна', async () => {
    const suffix = Date.now().toString(36);
    const slug = `c4-cat-${suffix}`;
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name) VALUES (${slug}, 'C4 категория')
      RETURNING id
    `;

    // 1) Активна: видна в дереве/DTO, резолвится по slug.
    let node = findNode(await getCategoryTree(), id);
    expect(node).toBeTruthy();
    expect(node!.isActive).toBe(true);
    expect(toCategoryTreeDto([node!]).length).toBe(1);
    expect(await getActiveCategoryIdBySlug(slug)).toBe(id);

    // 2) Скрываем (как updateCategory COALESCE is_active).
    await sql`UPDATE categories SET is_active = false WHERE id = ${id}`;
    node = findNode(await getCategoryTree(), id);
    expect(node!.isActive).toBe(false);
    expect(toCategoryTreeDto([node!]).length).toBe(0); // скрыта на витрине
    expect(await getActiveCategoryIdBySlug(slug)).toBeNull();

    // 3) Показываем снова — категория опять видна на витрине.
    await sql`UPDATE categories SET is_active = true WHERE id = ${id}`;
    node = findNode(await getCategoryTree(), id);
    expect(node!.isActive).toBe(true);
    expect(toCategoryTreeDto([node!]).length).toBe(1);
    expect(await getActiveCategoryIdBySlug(slug)).toBe(id);

    await sql`DELETE FROM categories WHERE id = ${id}`;
  });
});

function findNode(nodes: any[], id: string): any | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}
