-- =============================================================================
-- db/seed/demo-catalog.sql
-- -----------------------------------------------------------------------------
-- Этап 2, пакет П5 — ОПЦИОНАЛЬНЫЙ демонстрационный каталог (docs/05 §1.2, §7 П5).
--
-- НАЗНАЧЕНИЕ. Наполнить пустой магазин нейтральными примерными данными для
-- ознакомления/демо/smoke: дерево категорий, справочник характеристик (Цвет,
-- Размер) со значениями, несколько товаров с вариантами, привязкой к категориям,
-- характеристиками и остатками. Это НЕ обязательные данные ядра — боевой магазин
-- их НЕ получает (см. ниже).
--
-- УНИВЕРСАЛЬНОСТЬ (docs/02, ADR-003). Данные ОБОБЩЁННЫЕ и нейтральные
-- («Демо-категория», «Образец товара N»), без привязки к бренду/нише конкретного
-- интернет-магазина. Накат — только по флагу окружения SEED_DEMO_CATALOG=true в
-- scripts/init-shop.sh (по умолчанию ВЫКЛЮЧЕНО), чтобы боевой магазин не получил
-- демонстрационный «мусор». Медиа намеренно не сидируются (нет файлов в S3/mock).
--
-- ИДЕМПОТЕНТНОСТЬ (docs/05 §1.4, §7 П5). Естественные ключи — стабильные
-- citext-значения: categories.slug, products.sku/slug, product_variants.sku,
-- attributes.code, attribute_values (attribute_id, value). Все INSERT снабжены
-- ON CONFLICT ... DO NOTHING, а FK-цели находятся подзапросом по этим ключам.
-- Повторный накат не плодит дублей и не падает. Никаких хардкод-UUID — id
-- генерируются gen_random_uuid(), связи строятся по естественным ключам.
--
-- ПОДКЛЮЧЕНИЕ: накатывается psql из init-shop (шаг 5, опционально). Использует те
-- же таблицы, что и миграции 0005–0010.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Категории — дерево: один корень + три подкатегории.
--    Корень вставляем первым (его id нужен подкатегориям через parent_id).
-- -----------------------------------------------------------------------------
INSERT INTO categories (slug, name, description, sort, is_active) VALUES
  ('demo-root', 'Демо-категория', 'Корневая демонстрационная категория (пример наполнения).', 0, true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (parent_id, slug, name, description, sort, is_active)
SELECT root.id, sub.slug, sub.name, sub.description, sub.sort, true
FROM (SELECT id FROM categories WHERE slug = 'demo-root') AS root
CROSS JOIN (VALUES
  ('demo-cat-1', 'Демо-подкатегория 1', 'Первая демонстрационная подкатегория.', 10),
  ('demo-cat-2', 'Демо-подкатегория 2', 'Вторая демонстрационная подкатегория.', 20),
  ('demo-cat-3', 'Демо-подкатегория 3', 'Третья демонстрационная подкатегория.', 30)
) AS sub(slug, name, description, sort)
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Характеристики (справочная EAV, ADR-007): Цвет (вариантный) и Размер.
--    Ключ — attributes.code.
-- -----------------------------------------------------------------------------
INSERT INTO attributes (code, name, type, is_variant, is_filterable, is_required, sort) VALUES
  ('demo-color', 'Цвет',  'select', true,  true,  false, 10),
  ('demo-size',  'Размер', 'select', true,  true,  false, 20)
ON CONFLICT (code) DO NOTHING;

-- Значения словаря. Ключ — (attribute_id, value); attribute_id находим по коду.
INSERT INTO attribute_values (attribute_id, value, slug, sort)
SELECT a.id, v.value, v.slug, v.sort
FROM (SELECT id FROM attributes WHERE code = 'demo-color') AS a
CROSS JOIN (VALUES
  ('Красный', 'demo-red',   10),
  ('Синий',   'demo-blue',  20),
  ('Зелёный', 'demo-green', 30)
) AS v(value, slug, sort)
ON CONFLICT (attribute_id, value) DO NOTHING;

INSERT INTO attribute_values (attribute_id, value, slug, sort)
SELECT a.id, v.value, v.slug, v.sort
FROM (SELECT id FROM attributes WHERE code = 'demo-size') AS a
CROSS JOIN (VALUES
  ('S', 'demo-s', 10),
  ('M', 'demo-m', 20),
  ('L', 'demo-l', 30)
) AS v(value, slug, sort)
ON CONFLICT (attribute_id, value) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Товары — 4 образца. Ключ — products.sku (а также products.slug).
--    Статус 'active', цена NUMERIC. Привязку к категориям/вариантам/остаткам —
--    отдельными шагами ниже (по естественным ключам).
-- -----------------------------------------------------------------------------
INSERT INTO products (sku, slug, name, description, status, base_price) VALUES
  ('DEMO-001', 'demo-product-1', 'Образец товара 1', 'Демонстрационный товар №1 для ознакомления.', 'active', 1000.00),
  ('DEMO-002', 'demo-product-2', 'Образец товара 2', 'Демонстрационный товар №2 для ознакомления.', 'active', 1990.00),
  ('DEMO-003', 'demo-product-3', 'Образец товара 3', 'Демонстрационный товар №3 для ознакомления.', 'active', 2490.50),
  ('DEMO-004', 'demo-product-4', 'Образец товара 4', 'Демонстрационный товар №4 для ознакомления.', 'active',  750.00)
ON CONFLICT (sku) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Привязка товаров к категориям (M2M product_categories).
--    Ключ — PK (product_id, category_id). Первую связку помечаем основной.
-- -----------------------------------------------------------------------------
INSERT INTO product_categories (product_id, category_id, is_primary)
SELECT p.id, c.id, link.is_primary
FROM (VALUES
  ('DEMO-001', 'demo-cat-1', true),
  ('DEMO-002', 'demo-cat-1', true),
  ('DEMO-003', 'demo-cat-2', true),
  ('DEMO-004', 'demo-cat-3', true)
) AS link(sku, slug, is_primary)
JOIN products   p ON p.sku  = link.sku
JOIN categories c ON c.slug = link.slug
ON CONFLICT (product_id, category_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. Варианты товаров (1–2 на товар). Ключ — product_variants.sku.
-- -----------------------------------------------------------------------------
INSERT INTO product_variants (product_id, sku, name, price_delta, is_active, sort)
SELECT p.id, v.sku, v.name, v.price_delta, true, v.sort
FROM (VALUES
  ('DEMO-001', 'DEMO-001-RED-M',   'Красный / M',   0.00,   10),
  ('DEMO-001', 'DEMO-001-BLUE-L',  'Синий / L',     200.00, 20),
  ('DEMO-002', 'DEMO-002-GREEN-S', 'Зелёный / S',   0.00,   10),
  ('DEMO-003', 'DEMO-003-RED-L',   'Красный / L',   150.00, 10),
  ('DEMO-004', 'DEMO-004-BLUE-M',  'Синий / M',     0.00,   10)
) AS v(product_sku, sku, name, price_delta, sort)
JOIN products p ON p.sku = v.product_sku
ON CONFLICT (sku) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 6. Характеристики уровня варианта (product_attributes с variant_id).
--    Для select-атрибутов значение — ссылка value_id на словарь.
--    Идемпотентность — через уникальный индекс product_attributes_uniq.
-- -----------------------------------------------------------------------------
INSERT INTO product_attributes (product_id, variant_id, attribute_id, value_id)
SELECT pv.product_id, pv.id, a.id, av.id
FROM (VALUES
  -- variant_sku,        attr_code,    value
  ('DEMO-001-RED-M',   'demo-color', 'Красный'),
  ('DEMO-001-RED-M',   'demo-size',  'M'),
  ('DEMO-001-BLUE-L',  'demo-color', 'Синий'),
  ('DEMO-001-BLUE-L',  'demo-size',  'L'),
  ('DEMO-002-GREEN-S', 'demo-color', 'Зелёный'),
  ('DEMO-002-GREEN-S', 'demo-size',  'S'),
  ('DEMO-003-RED-L',   'demo-color', 'Красный'),
  ('DEMO-003-RED-L',   'demo-size',  'L'),
  ('DEMO-004-BLUE-M',  'demo-color', 'Синий'),
  ('DEMO-004-BLUE-M',  'demo-size',  'M')
) AS pa(variant_sku, attr_code, value)
JOIN product_variants pv ON pv.sku   = pa.variant_sku
JOIN attributes        a ON a.code   = pa.attr_code
JOIN attribute_values av ON av.attribute_id = a.id AND av.value = pa.value
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7. Остатки (inventory) — по строке на вариант, склад 'main'.
--    Идемпотентность — через уникальный индекс inventory_unit_uniq.
-- -----------------------------------------------------------------------------
INSERT INTO inventory (product_id, variant_id, warehouse_code, quantity)
SELECT pv.product_id, pv.id, 'main', inv.quantity
FROM (VALUES
  ('DEMO-001-RED-M',   25),
  ('DEMO-001-BLUE-L',  10),
  ('DEMO-002-GREEN-S', 40),
  ('DEMO-003-RED-L',    5),
  ('DEMO-004-BLUE-M',  60)
) AS inv(variant_sku, quantity)
JOIN product_variants pv ON pv.sku = inv.variant_sku
ON CONFLICT DO NOTHING;
