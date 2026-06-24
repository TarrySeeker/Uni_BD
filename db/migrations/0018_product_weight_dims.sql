-- =============================================================================
-- 0018_product_weight_dims.sql  (Этап 4 — модуль cdek, пакет A)
-- Вес и габариты товара/варианта для расчёта доставки СДЭК (docs/08 §3.2).
--
-- В каталоге Admik НЕ было веса/габаритов (только product_media.width/height —
-- пиксели). Для расчёта СДЭК нужен хотя бы вес. Решение (мульти-магазин, без
-- хардкода): nullable-поля на ОБА уровня; NULL → берётся дефолт магазина
-- (CDEK_DEFAULT_*, аналог cdek-dimensions.php). Вес варианта переопределяет вес
-- товара (приоритет: вариант → товар → дефолт).
--
-- Это единственное вторжение Этапа 4 в каталог — изолированный аддитив,
-- допустимый в зоне пакета A (миграция нужна для СДЭК-расчёта).
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; CHECK (>= 0) через DO-блок +
-- pg_constraint (ALTER ... ADD CONSTRAINT не поддерживает IF NOT EXISTS,
-- повторный накат не должен падать на «constraint already exists»).
-- GRANT на products/product_variants уже выдан в 0006/0007 — НЕ дублируем.
-- =============================================================================

-- --- Вес/габариты товара (вес в граммах, габариты в см) ----------------------
ALTER TABLE products         ADD COLUMN IF NOT EXISTS weight_g  integer;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS length_cm integer;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS width_cm  integer;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS height_cm integer;

-- --- Вес/габариты варианта (переопределяют товар) ----------------------------
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS weight_g  integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS length_cm integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS width_cm  integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS height_cm integer;

-- --- CHECK (>= 0) идемпотентно (ADD CONSTRAINT без IF NOT EXISTS) -------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_weight_nonneg'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_weight_nonneg
      CHECK (weight_g IS NULL OR weight_g >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_dims_nonneg'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_dims_nonneg
      CHECK (
        (length_cm IS NULL OR length_cm >= 0) AND
        (width_cm  IS NULL OR width_cm  >= 0) AND
        (height_cm IS NULL OR height_cm >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'variants_weight_nonneg'
  ) THEN
    ALTER TABLE product_variants ADD CONSTRAINT variants_weight_nonneg
      CHECK (weight_g IS NULL OR weight_g >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'variants_dims_nonneg'
  ) THEN
    ALTER TABLE product_variants ADD CONSTRAINT variants_dims_nonneg
      CHECK (
        (length_cm IS NULL OR length_cm >= 0) AND
        (width_cm  IS NULL OR width_cm  >= 0) AND
        (height_cm IS NULL OR height_cm >= 0)
      );
  END IF;
END $$;

-- GRANT не нужен: права на products/product_variants выданы в 0006/0007,
-- новые столбцы наследуют табличные привилегии роли admik_app.

INSERT INTO schema_migrations (version, name)
VALUES ('0018', 'product_weight_dims')
ON CONFLICT DO NOTHING;
