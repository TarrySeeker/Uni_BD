-- =============================================================================
-- 0009_catalog_media.sql
-- -----------------------------------------------------------------------------
-- Этап 2, пакет П1 — каталог: медиа товаров/вариантов (docs/05 §2.5).
--   product_media — метаданные + storage_key объекта в S3/MinIO (или mock-путь).
--   БД хранит метаданные, а не байты; mime — по реальным magic-bytes (§3).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- variant_id → ON DELETE SET NULL: удаление варианта не удаляет общий медиафайл (§2.7).
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_media (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid    NOT NULL REFERENCES products(id)        ON DELETE CASCADE,
  variant_id  uuid    REFERENCES product_variants(id)         ON DELETE SET NULL,  -- опц. привязка к варианту
  storage_key text    NOT NULL,                 -- ключ объекта в S3/MinIO (или относительный путь в mock)
  url         text,                             -- публичный URL (S3_PUBLIC_URL + key); вычислим, кешируем
  type        text    NOT NULL DEFAULT 'image'
              CHECK (type IN ('image','video','document')),
  mime        text    NOT NULL,                 -- реальный MIME по magic-bytes (§3)
  alt         text    NOT NULL DEFAULT '',      -- alt-текст (a11y/SEO)
  width       integer,                          -- для изображений (после обработки sharp)
  height      integer,
  size_bytes  bigint,
  sort        integer NOT NULL DEFAULT 0,        -- порядок в галерее
  is_primary  boolean NOT NULL DEFAULT false,    -- главное изображение товара
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_media_product_idx ON product_media (product_id, sort);
CREATE INDEX IF NOT EXISTS product_media_variant_idx ON product_media (variant_id);
-- Не более одного главного изображения на товар:
CREATE UNIQUE INDEX IF NOT EXISTS product_media_primary_uniq
  ON product_media (product_id) WHERE is_primary;

-- GRANT для рантайма (§2): app выполняет полный DML на медиа-метаданных.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_media TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0009', 'catalog_media')
ON CONFLICT DO NOTHING;
