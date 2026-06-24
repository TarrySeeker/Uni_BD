-- =============================================================================
-- 0023_cms_page_sections.sql  (Этап 5 — подсистема 5.1 CMS, пакет 5.C-1)
-- cms_page_sections — секции контент-страниц (docs/11 §5.1.1/§5.1.2, ADR-012).
--
-- Ядро паттерна 2x2 (page_sections), но НОРМАЛИЗОВАНО как дочерняя таблица с
-- FK CASCADE на cms_pages (целостность + атомарный reorder), а не плоская
-- (page_path, section_key). type — дискриминатор Zod-валидации content
-- (CmsSectionContentSchema, lib/cms/schemas.ts). content валидируется на сервере
-- (дискриминированный union по type) + rich-text санитизируется (анти-XSS).
--
-- cms_page_revisions — снимок страницы+секций на момент публикации (gap
-- «версионирование» из 2x2); пишется транзакционно при publishCmsPage (5.C-2).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS; UNIQUE(page_id, section_key) и
-- UNIQUE(page_id, revision) — в CREATE TABLE; CHECK размера content (защита от
-- гигантского блока, gap «нет maxsize» из 2x2) добавляется через DO-блок +
-- pg_constraint (ALTER ... ADD CONSTRAINT не поддерживает IF NOT EXISTS); GRANT
-- идемпотентен; запись в schema_migrations ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cms_page_sections (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        uuid          NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
  section_key    text          NOT NULL,
  type           text          NOT NULL
                 CHECK (type IN ('hero','text','banner','products_grid','faq','cta','gallery')),
  content        jsonb         NOT NULL DEFAULT '{}'::jsonb,
  display_order  integer       NOT NULL DEFAULT 0,
  enabled        boolean       NOT NULL DEFAULT true,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (page_id, section_key)
);

CREATE INDEX IF NOT EXISTS cms_page_sections_order_idx
  ON cms_page_sections (page_id, display_order);

-- CHECK размера content идемпотентно (ADD CONSTRAINT без IF NOT EXISTS).
-- Защита от хранения гигантских JSONB-блоков (gap «нет maxsize» из 2x2).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cms_page_sections_content_size_chk'
  ) THEN
    ALTER TABLE cms_page_sections ADD CONSTRAINT cms_page_sections_content_size_chk
      CHECK (pg_column_size(content) < 65536);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- cms_page_revisions — версионирование публикаций (снимок JSON страницы+секций).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cms_page_revisions (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid          NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
  revision    integer       NOT NULL,
  snapshot    jsonb         NOT NULL,
  created_by  uuid          REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (page_id, revision)
);

CREATE INDEX IF NOT EXISTS cms_page_revisions_page_idx
  ON cms_page_revisions (page_id, revision DESC);

-- Полный DML для рантайма приложения (Server Actions через defineAction).
GRANT SELECT, INSERT, UPDATE, DELETE ON cms_page_sections  TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cms_page_revisions TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0023', 'cms_page_sections')
ON CONFLICT DO NOTHING;
