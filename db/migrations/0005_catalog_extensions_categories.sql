-- =============================================================================
-- 0005_catalog_extensions_categories.sql
-- -----------------------------------------------------------------------------
-- Этап 2, пакет П1 — каталог: расширения + дерево категорий (docs/05 §2.1).
--   * Расширение pg_trgm — триграммный поиск (FTS по названию/артикулу, §2.2).
--   * categories — дерево категорий (adjacency list через self-FK parent_id).
--
-- Идемпотентность (ADR-002): CREATE EXTENSION/TABLE/INDEX IF NOT EXISTS,
-- INSERT ... ON CONFLICT DO NOTHING — повторный накат безопасен.
-- FK parent_id → ON DELETE RESTRICT: нельзя удалить категорию с детьми (§2.7).
-- =============================================================================

-- Триграммный поиск (GIN gin_trgm_ops) для ILIKE/similarity по name/sku (§2.2).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- categories (§2.1) — дерево, adjacency list. slug citext (регистронезависим).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       uuid         REFERENCES categories(id) ON DELETE RESTRICT,  -- self-FK, дерево
  slug            citext       NOT NULL,                       -- ЧПУ, уникален (регистронезависимо)
  name            text         NOT NULL,
  description     text         NOT NULL DEFAULT '',
  sort            integer      NOT NULL DEFAULT 0,             -- порядок среди соседей
  is_active       boolean      NOT NULL DEFAULT true,
  -- SEO-поля (редактируются на Этапе 2; генерация карт сайта — Этап 5.3):
  seo_title       text,
  seo_description text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  -- защита от тривиального цикла «сам себе родитель»:
  CONSTRAINT categories_no_self_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_slug_uniq   ON categories (slug);
CREATE INDEX        IF NOT EXISTS categories_parent_idx  ON categories (parent_id);
CREATE INDEX        IF NOT EXISTS categories_active_idx  ON categories (is_active);
CREATE INDEX        IF NOT EXISTS categories_sort_idx    ON categories (parent_id, sort);

-- GRANT для рантайма (§2): app выполняет полный DML на категориях.
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0005', 'catalog_extensions_categories')
ON CONFLICT DO NOTHING;
