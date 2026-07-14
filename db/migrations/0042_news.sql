-- =============================================================================
-- 0042_news.sql  (Фаза 1 — шаг 5; docs/24 §3, §10)
-- Раздел «Новости» — вертикальный срез по эталону cms_pages (0022). Порт eAdmin
-- b_news (config/cats/news.php + blocks/news.php): заголовок/ссылка/раздел/дата/
-- анонс/текст/картинка/seo/lang. Отдельный ТУМБЛИРУЕМЫЙ модуль `news` (не каждый
-- магазин ведёт блог).
--
-- Отличия модели от eAdmin (нормализация под Admik):
--   • id int → uuid;
--   • date (varchar-unix) → published_at timestamptz;
--   • visible tinyint → status-триада draft/published/archived (как cms_pages);
--   • main_image → cover_image_key (КЛЮЧ объекта S3, не URL — как каталог-медиа);
--   • одна строка на язык (source_id+lang) → одна сущность + jsonb-оверлей i18n.
--
-- i18n (ADR-i18n, docs/24 §1): title/excerpt/body/group_label + SEO/OG переводимы;
--   база (ru) в колонках, en/fr — в translations jsonb (whitelist NEWS_TR_FIELDS).
--   slug, cover/og-ключи, published_at, status, sort_order, noindex — НЕ переводимы.
--   translations вписан ПРЯМО в CREATE TABLE (новая таблица — ALTER не нужен).
--
-- Без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
--
-- Идемпотентно/аддитивно (§6.4/ADR-015): CREATE TABLE/INDEX IF NOT EXISTS, CHECK
-- множества значений встроены в CREATE TABLE, CHECK jsonb_typeof — через DO-блок
-- (pg_constraint), GRANT идемпотентен, schema_migrations ON CONFLICT DO NOTHING.
-- Таблично-уровневый GRANT покрывает будущие аддитивные колонки автоматически.
-- =============================================================================

CREATE TABLE IF NOT EXISTS news (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              citext        NOT NULL,                     -- ЧПУ (← b_news.link); уникален, НЕ переводимо
  title             text          NOT NULL,                     -- заголовок (← name); база = язык по умолчанию (ru)
  group_label       text,                                       -- рубрика/раздел (← group); переводимо
  excerpt           text,                                       -- анонс (← anons); переводимо
  body              text,                                       -- текст (← text, rich HTML — санитайз); переводимо
  cover_image_key   text,                                       -- обложка (← main_image); КЛЮЧ объекта S3, НЕ URL

  status            text          NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),  -- жизненный цикл (← visible)
  published_at      timestamptz,                                -- дата публикации (← date unix→timestamptz)
  sort_order        integer       NOT NULL DEFAULT 0,           -- ручной порядок (← sort)

  -- SEO/OG (docs/11 §5.3):
  seo_title         text,
  seo_description   text,
  og_title          text,
  og_description    text,
  og_image_key      text,                                       -- КЛЮЧ объекта S3 (URL собирает витрина)
  noindex           boolean       NOT NULL DEFAULT false,
  canonical_url     text,

  translations      jsonb         NOT NULL DEFAULT '{}'::jsonb, -- i18n-оверлей: whitelist NEWS_TR_FIELDS

  -- audit-trail на строке:
  created_by        uuid          REFERENCES users(id) ON DELETE SET NULL,
  updated_by        uuid          REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

-- Уникальность slug (регистронезависимо — citext) + витринные выборки.
CREATE UNIQUE INDEX IF NOT EXISTS news_slug_uniq       ON news (slug);
CREATE INDEX        IF NOT EXISTS news_status_idx       ON news (status);
CREATE INDEX        IF NOT EXISTS news_published_idx    ON news (published_at DESC);
-- Лента: ручной порядок, затем свежие выше (совпадает с ORDER BY репозитория).
CREATE INDEX        IF NOT EXISTS news_sort_idx         ON news (sort_order, published_at DESC);

-- CHECK (jsonb_typeof(translations) = 'object') — оверлей всегда объект (см. 0034/0035/0039).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'news_translations_obj_chk'
  ) THEN
    ALTER TABLE news
      ADD CONSTRAINT news_translations_obj_chk
      CHECK (jsonb_typeof(translations) = 'object');
  END IF;
END $$;

-- Полный DML для рантайма приложения (Server Actions через defineAction).
GRANT SELECT, INSERT, UPDATE, DELETE ON news TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0042', 'news')
ON CONFLICT DO NOTHING;
