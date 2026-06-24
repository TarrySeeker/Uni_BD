-- =============================================================================
-- 0021_seo_entity_fields.sql  (Этап 5 — подсистема 5.3 SEO, пакет 5.S-1)
-- SEO-метаполя на сущностях каталога products/categories/brands (docs/11 §5.3.1).
--
-- slug (citext UNIQUE) и seo_title/seo_description уже есть (0005/0006/0011) —
-- НЕ дублируем. Добавляем только недостающее: open-graph, canonical, noindex.
--
-- Решение (мульти-магазин, без хардкода): SEO-поля живут НА самих сущностях
-- (не отдельная page_metadata, docs/11 §5.3.7). og_image_key — КЛЮЧ объекта S3
-- (как product_media.storage_key / brands.logo_key); URL собирает рантайм-слой
-- storage.publicUrl — домен не хардкодим. canonical_url — абсолютный https-URL
-- или path с '/'; NULL → автоген из slug + site_url (shop_settings.seo).
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; CHECK (noindex NOT NULL) встроен в
-- объявление колонки (DEFAULT false). GRANT на products/categories/brands уже
-- выдан в 0005/0006/0011 — новые столбцы наследуют табличные привилегии
-- admik_app, повторно НЕ выдаём. Запись в schema_migrations ON CONFLICT.
-- =============================================================================

-- --- Товары ------------------------------------------------------------------
ALTER TABLE products   ADD COLUMN IF NOT EXISTS og_title      text;
ALTER TABLE products   ADD COLUMN IF NOT EXISTS og_description text;
ALTER TABLE products   ADD COLUMN IF NOT EXISTS og_image_key  text;
ALTER TABLE products   ADD COLUMN IF NOT EXISTS canonical_url text;
ALTER TABLE products   ADD COLUMN IF NOT EXISTS noindex       boolean NOT NULL DEFAULT false;

-- --- Категории ----------------------------------------------------------------
ALTER TABLE categories ADD COLUMN IF NOT EXISTS og_title      text;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS og_description text;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS og_image_key  text;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS canonical_url text;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS noindex       boolean NOT NULL DEFAULT false;

-- --- Бренды -------------------------------------------------------------------
ALTER TABLE brands     ADD COLUMN IF NOT EXISTS og_title      text;
ALTER TABLE brands     ADD COLUMN IF NOT EXISTS og_description text;
ALTER TABLE brands     ADD COLUMN IF NOT EXISTS og_image_key  text;
ALTER TABLE brands     ADD COLUMN IF NOT EXISTS canonical_url text;
ALTER TABLE brands     ADD COLUMN IF NOT EXISTS noindex       boolean NOT NULL DEFAULT false;

-- GRANT не нужен: права на products/categories/brands выданы в 0005/0006/0011,
-- новые столбцы наследуют табличные привилегии роли admik_app.

INSERT INTO schema_migrations (version, name)
VALUES ('0021', 'seo_entity_fields')
ON CONFLICT DO NOTHING;
