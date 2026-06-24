-- =============================================================================
-- 0010_catalog_inventory.sql
-- -----------------------------------------------------------------------------
-- Этап 2, пакет П1 — каталог: остатки (docs/05 §2.6).
--   inventory — остаток на (товар/вариант, склад). Отдельная таблица (не поле
--   stock в варианте) — задел под мультисклад (warehouse_code) и резервы (reserved).
--   Доступное к продаже = quantity - reserved (вычисляется, не хранится).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- FK product_id/variant_id → ON DELETE CASCADE: остаток без юнита не нужен (§2.7).
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid    NOT NULL REFERENCES products(id)        ON DELETE CASCADE,
  variant_id     uuid    REFERENCES product_variants(id)         ON DELETE CASCADE,  -- NULL → товар без вариантов
  warehouse_code citext  NOT NULL DEFAULT 'main',   -- задел под мультисклад (сейчас всегда 'main')
  quantity       integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),   -- физический остаток, не уходит в минус
  reserved       integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),   -- задел: резерв под заказы (Этап 3)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_reserved_le_qty CHECK (reserved <= quantity)  -- резерв не больше наличия
);

-- Одна строка остатка на (товар/вариант, склад):
CREATE UNIQUE INDEX IF NOT EXISTS inventory_unit_uniq
  ON inventory (product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), warehouse_code);
CREATE INDEX IF NOT EXISTS inventory_variant_idx ON inventory (variant_id);

-- GRANT для рантайма (§2): app выполняет полный DML на остатках.
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0010', 'catalog_inventory')
ON CONFLICT DO NOTHING;
