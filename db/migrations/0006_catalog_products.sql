-- =============================================================================
-- 0006_catalog_products.sql
-- -----------------------------------------------------------------------------
-- Этап 2, пакет П1 — каталог: товары + M2M товар↔категория (docs/05 §2.2, ADR-007).
--   * products — карточка товара (sku/slug citext, статус, базовая цена, FTS).
--   * product_categories — связь многие-ко-многим (is_primary — основная категория).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- FK CASCADE на M2M (§2.7): удаление товара/категории чистит связки.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- products (§2.2). Деньги — numeric(14,2). attributes_cache — JSONB-проекция
-- поверх EAV-источника истины (ADR-007), пересобирается при изменении атрибутов.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sku              citext        NOT NULL,                  -- артикул товара, уникален
  slug             citext        NOT NULL,                  -- ЧПУ, уникален
  name             text          NOT NULL,
  description      text          NOT NULL DEFAULT '',       -- rich-text (Tiptap → HTML/JSON)
  status           text          NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','active','archived')),
  base_price       numeric(14,2) NOT NULL DEFAULT 0 CHECK (base_price >= 0),  -- базовая цена
  -- Презентационный кеш характеристик (ADR-007: JSONB-проекция поверх EAV):
  attributes_cache jsonb         NOT NULL DEFAULT '{}'::jsonb,
  -- SEO:
  seo_title        text,
  seo_description  text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_sku_uniq    ON products (sku);
CREATE UNIQUE INDEX IF NOT EXISTS products_slug_uniq   ON products (slug);
CREATE INDEX        IF NOT EXISTS products_status_idx  ON products (status);
CREATE INDEX        IF NOT EXISTS products_created_idx ON products (created_at DESC);
-- Полнотекстовый поиск по названию/артикулу через триграммы (pg_trgm, §2.2):
CREATE INDEX        IF NOT EXISTS products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
CREATE INDEX        IF NOT EXISTS products_sku_trgm_idx  ON products USING gin (sku  gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- product_categories (§2.2, ADR-007) — M2M товар ↔ категория.
-- is_primary — основная категория (хлебные крошки/канонический URL).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_categories (
  product_id   uuid    NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  category_id  uuid    NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  is_primary   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX IF NOT EXISTS product_categories_cat_idx ON product_categories (category_id);
-- Не более одной основной категории на товар:
CREATE UNIQUE INDEX IF NOT EXISTS product_categories_primary_uniq
  ON product_categories (product_id) WHERE is_primary;

-- GRANT для рантайма (§2): app выполняет полный DML на товарах и связках.
GRANT SELECT, INSERT, UPDATE, DELETE ON products           TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0006', 'catalog_products')
ON CONFLICT DO NOTHING;
