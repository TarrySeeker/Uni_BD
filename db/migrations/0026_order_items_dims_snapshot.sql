-- =============================================================================
-- 0026_order_items_dims_snapshot.sql  (Этап 4 — модуль cdek, проброс габаритов)
-- Снимок веса/габаритов позиции заказа для расчёта/создания доставки СДЭК.
--
-- 0018 добавил вес/габариты на products/product_variants (резолв приоритетом
-- вариант→товар→дефолт магазина). Но order_items хранит СНИМОК каталога на момент
-- покупки (ADR-010): цена/название/sku/атрибуты фиксируются, чтобы поздняя правка
-- каталога не меняла историю заказа. Вес/габариты ОТПРАВЛЕНИЯ должны быть таким же
-- снимком — иначе после редактирования товара пересчёт/создание накладной СДЭК
-- использовали бы НЕ те габариты, что были при оформлении (anti-tamper).
--
-- Поэтому фиксируем РЕЗОЛВНУТЫЙ (вариант→товар→дефолт) вес/габариты позиции в
-- момент createOrder. NULL допустим (товар без габаритов И без дефолта env — тогда
-- aggregatePackage подставит фоллбэк магазина при создании отправления).
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; CHECK (>= 0) через DO-блок +
-- pg_constraint (ALTER ADD CONSTRAINT не поддерживает IF NOT EXISTS). Без backfill:
-- существующие строки получают NULL → дефолт магазина при расчёте (поведение до
-- этой миграции сохранено). GRANT на order_items уже выдан в 0012 — НЕ дублируем.
-- =============================================================================

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS weight_g  integer;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS length_cm integer;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS width_cm  integer;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS height_cm integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_weight_nonneg'
  ) THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_weight_nonneg
      CHECK (weight_g IS NULL OR weight_g >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_dims_nonneg'
  ) THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_dims_nonneg
      CHECK (
        (length_cm IS NULL OR length_cm >= 0) AND
        (width_cm  IS NULL OR width_cm  >= 0) AND
        (height_cm IS NULL OR height_cm >= 0)
      );
  END IF;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('0026', 'order_items_dims_snapshot')
ON CONFLICT DO NOTHING;
