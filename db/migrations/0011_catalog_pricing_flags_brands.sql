-- =============================================================================
-- 0011_catalog_pricing_flags_brands.sql
-- Этап 2.x — расширение каталога по референсным витринам (docs/06 §3–§4, ADR-009):
--   * compare_at_price (цена «было») в products и product_variants — скидка вычисляется;
--   * флаги товара is_featured (ручной) и is_new (NULL=вычисляемо по дате, override);
--   * таблица brands (опциональна, пуста без брендов) + products.brand_id (nullable).
-- НЕ входит: vehicle fitment (VIN) — отдельный опциональный модуль `fitment` (docs/06 §3.4),
--   точка расширения, в этой миграции НЕ создаётся.
--
-- Идемпотентно: ADD COLUMN/CREATE ... IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- CHECK-ограничения добавляются через DO-блок с проверкой pg_constraint, т.к.
-- `ALTER TABLE ... ADD CONSTRAINT` НЕ поддерживает IF NOT EXISTS — повторный накат
-- не должен падать на «constraint already exists».
-- =============================================================================

-- --- 3.1. Акционная цена «было» (скидка вычисляется в коде/запросе) ----------
-- Источник истины актуальной цены — base_price (товар) / price_override+price_delta
-- (вариант); compare_at_price — только «зачёркнутая» цена для сравнения.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS compare_at_price numeric(14,2);

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS compare_at_price numeric(14,2);

-- CHECK (compare_at_price >= 0) идемпотентно (ADD CONSTRAINT без IF NOT EXISTS):
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_compare_at_price_chk'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_compare_at_price_chk
      CHECK (compare_at_price IS NULL OR compare_at_price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_compare_at_price_chk'
  ) THEN
    ALTER TABLE product_variants
      ADD CONSTRAINT product_variants_compare_at_price_chk
      CHECK (compare_at_price IS NULL OR compare_at_price >= 0);
  END IF;
END $$;

-- --- 3.2. Флаги товара -------------------------------------------------------
-- is_featured: ручной маркетинговый флаг «Хит/Рекомендуемый» (вычислить нельзя).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;
-- is_new: NULL → новизна вычисляется по created_at и настройке SHOP_NEW_PRODUCT_DAYS;
--         true/false → явное переопределение редактором (троичная логика, nullable намеренно).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_new boolean;

-- Частичные индексы под подборки витрины (фасеты «Хиты»/«Новинки»):
CREATE INDEX IF NOT EXISTS products_featured_idx ON products (is_featured) WHERE is_featured;
CREATE INDEX IF NOT EXISTS products_is_new_idx   ON products (is_new)       WHERE is_new;
-- «Со скидкой» — вычисляемый предикат (compare_at_price > base_price), отдельный флаг НЕ хранится;
-- частичный индекс ускоряет выборку подборки «Со скидкой»:
CREATE INDEX IF NOT EXISTS products_has_compare_idx
  ON products (id) WHERE compare_at_price IS NOT NULL;

-- --- 3.3. Бренды (опционально; пусто для магазинов без брендов) --------------
CREATE TABLE IF NOT EXISTS brands (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            citext      NOT NULL,                  -- ЧПУ бренда, уникален
  name            text        NOT NULL,
  description     text        NOT NULL DEFAULT '',
  logo_key        text,                                  -- ключ объекта в S3/MinIO (как product_media.storage_key)
  is_active       boolean     NOT NULL DEFAULT true,
  sort            integer     NOT NULL DEFAULT 0,
  seo_title       text,
  seo_description text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS brands_slug_uniq  ON brands (slug);
CREATE INDEX        IF NOT EXISTS brands_active_idx ON brands (is_active);

-- products.brand_id — nullable: товар может быть без бренда.
-- ON DELETE SET NULL: удаление бренда не удаляет товары, лишь снимает привязку.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS products_brand_idx ON products (brand_id);  -- фасетный фильтр по бренду

-- --- Гранты и регистрация миграции ------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON brands TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0011', 'catalog_pricing_flags_brands')
ON CONFLICT DO NOTHING;
