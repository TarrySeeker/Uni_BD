\set ON_ERROR_STOP on
BEGIN;

-- Бэкап затрагиваемых строк (на случай отката вручную).
CREATE TABLE IF NOT EXISTS _bak_categories_20260717 AS TABLE categories WITH NO DATA;
CREATE TABLE IF NOT EXISTS _bak_product_categories_20260717 AS TABLE product_categories WITH NO DATA;

-- Родитель — узел catalog.
\set catalog_slug 'catalog'

-- 1) Создаём «Мода» (fashion) и «Лайфстайл» (lifestyle) как верхние разделы под catalog.
--    sort: fashion=15 (между twilly=5/platki=10 и odezhda=20), lifestyle=35 (после dekor=30).
INSERT INTO categories (slug, name, description, parent_id, sort, is_active)
SELECT 'fashion', 'Мода', '', c.id, 15, true
FROM categories c WHERE c.slug='catalog'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (slug, name, description, parent_id, sort, is_active)
SELECT 'lifestyle', 'Лайфстайл', '', c.id, 35, true
FROM categories c WHERE c.slug='catalog'
ON CONFLICT (slug) DO NOTHING;

-- 2) Привязка товаров many-to-many (is_primary=false — основная категория товара не
--    меняется). «Мода» = товары детей odezhda-i-aksessuari; «Лайфстайл» = товары детей
--    dekor-i-predmeti-interera. Берём товары, лежащие в этих поддеревьях, и вешаем
--    доп. связь на fashion/lifestyle. Дублей не будет — PK (product_id, category_id).

WITH fashion_cat AS (SELECT id FROM categories WHERE slug='fashion'),
     fashion_src AS (
       SELECT DISTINCT pc.product_id
       FROM product_categories pc
       JOIN categories c ON c.id = pc.category_id
       JOIN categories p ON p.id = c.parent_id
       WHERE p.slug = 'odezhda-i-aksessuari'
     )
INSERT INTO product_categories (product_id, category_id, is_primary)
SELECT s.product_id, f.id, false
FROM fashion_src s CROSS JOIN fashion_cat f
ON CONFLICT (product_id, category_id) DO NOTHING;

WITH life_cat AS (SELECT id FROM categories WHERE slug='lifestyle'),
     life_src AS (
       SELECT DISTINCT pc.product_id
       FROM product_categories pc
       JOIN categories c ON c.id = pc.category_id
       JOIN categories p ON p.id = c.parent_id
       WHERE p.slug = 'dekor-i-predmeti-interera'
     )
INSERT INTO product_categories (product_id, category_id, is_primary)
SELECT s.product_id, l.id, false
FROM life_src s CROSS JOIN life_cat l
ON CONFLICT (product_id, category_id) DO NOTHING;

-- 3) Отчёт.
\echo '=== созданные категории ==='
SELECT slug, name, sort, is_active FROM categories WHERE slug IN ('fashion','lifestyle');
\echo '=== товаров привязано ==='
SELECT c.slug, count(*) AS products
FROM product_categories pc JOIN categories c ON c.id=pc.category_id
WHERE c.slug IN ('fashion','lifestyle') GROUP BY c.slug;

COMMIT;
