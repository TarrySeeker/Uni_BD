-- =============================================================================
-- 0007_catalog_variants.sql
-- -----------------------------------------------------------------------------
-- Этап 2, пакет П1 — каталог: вариации товара (docs/05 §2.3).
--   product_variants — вариант товара (свой sku, цена override/delta, кеш атрибутов).
--   Эффективная цена = COALESCE(price_override, base_price + price_delta).
--   Остаток варианта — НЕ здесь, а в inventory (0010, §2.6).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- FK product_id → ON DELETE CASCADE: варианты живут только вместе с товаром (§2.7).
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_variants (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid          NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           citext        NOT NULL,                 -- собственный артикул варианта, уникален
  name          text          NOT NULL DEFAULT '',      -- напр. «Красный / M» (можно автособирать)
  -- Цена варианта: либо абсолютная price_override, либо надбавка price_delta к base_price.
  price_override numeric(14,2) CHECK (price_override >= 0),  -- NULL → берём base_price (+delta)
  price_delta    numeric(14,2) NOT NULL DEFAULT 0,           -- доп. цена относительно base_price
  is_active      boolean       NOT NULL DEFAULT true,
  sort           integer       NOT NULL DEFAULT 0,
  -- атрибуты варианта (цвет/размер именно этой вариации) — нормализованно через
  -- product_attributes (variant_id), см. §2.4; здесь — презентационный кеш:
  attributes_cache jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_sku_uniq    ON product_variants (sku);
CREATE INDEX        IF NOT EXISTS product_variants_product_idx ON product_variants (product_id, sort);

-- GRANT для рантайма (§2): app выполняет полный DML на вариантах.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_variants TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0007', 'catalog_variants')
ON CONFLICT DO NOTHING;
