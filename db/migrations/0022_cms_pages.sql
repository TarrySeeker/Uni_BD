-- =============================================================================
-- 0022_cms_pages.sql  (Этап 5 — подсистема 5.1 CMS, пакет 5.C-1)
-- cms_pages — контент-страницы магазина (docs/11 §5.1.1/§5.1.2, ADR-012).
--
-- Универсальная контент-механика (не привязана к конкретному ИМ): страница =
-- slug + title + статус (триада draft/published/archived, закрывает gap «нет
-- draft» из 2x2) + SEO/sitemap-поля. Секции страницы — в 0023 (нормализованная
-- дочерняя таблица cms_page_sections, FK CASCADE).
--
-- SEO/sitemap-поля включены ПРЯМО в CREATE TABLE (docs/11 §2): 5.1 и 5.3 в одном
-- этапе — ALTER «вдогонку» не нужен. og_image_url — публичный URL (для CMS-страниц
-- картинка задаётся URL, в отличие от каталога, где хранится ключ S3 og_image_key).
--
-- Без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS; CHECK-ограничения встроены в
-- CREATE TABLE (не ALTER'ом — поэтому повторный CREATE IF NOT EXISTS не дублирует);
-- GRANT идемпотентен; запись в schema_migrations ON CONFLICT DO NOTHING. Опц.
-- идемпотентный seed демо-страницы 'about' (ON CONFLICT DO NOTHING).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cms_pages (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                citext        NOT NULL,                  -- ЧПУ страницы, уникален
  title               text          NOT NULL,
  status              text          NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','published','archived')),
  published_at        timestamptz,                             -- ставится при первом переходе в published
  -- SEO (docs/11 §5.3):
  seo_title           text,
  seo_description     text,
  og_image_url        text,                                    -- публичный URL OG-картинки
  canonical_url       text,
  noindex             boolean       NOT NULL DEFAULT false,
  -- sitemap:
  sitemap_priority    numeric(2,1)  CHECK (sitemap_priority IS NULL
                        OR (sitemap_priority >= 0 AND sitemap_priority <= 1)),
  sitemap_changefreq  text          CHECK (sitemap_changefreq IS NULL OR sitemap_changefreq IN
                        ('always','hourly','daily','weekly','monthly','yearly','never')),
  -- audit-trail на строке:
  created_by          uuid          REFERENCES users(id) ON DELETE SET NULL,
  updated_by          uuid          REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cms_pages_slug_uniq      ON cms_pages (slug);
CREATE INDEX        IF NOT EXISTS cms_pages_status_idx     ON cms_pages (status);
CREATE INDEX        IF NOT EXISTS cms_pages_published_idx  ON cms_pages (published_at DESC);

-- Полный DML для рантайма приложения (Server Actions через defineAction).
GRANT SELECT, INSERT, UPDATE, DELETE ON cms_pages TO admik_app;

-- Опциональный идемпотентный seed демо-страницы (черновик «О компании»).
INSERT INTO cms_pages (slug, title, status)
VALUES ('about', 'О компании', 'draft')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES ('0022', 'cms_pages')
ON CONFLICT DO NOTHING;
