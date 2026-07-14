-- =============================================================================
-- 0047_designers.sql
-- §9 / ADR §4.4 — порт b_stuff (eAdmin «Персона») в новый срез lib/designers.
--
-- Дизайнер — самостоятельная публичная персона (аватар, rich-описание, страна,
-- соцсети, счётчик работ, видео, фото для страницы, публичная страница /designers,
-- фичеринг). Моделируется 1:1 по анатомии brands, НО отдельной таблицей: семантика
-- иная (у brands есть url/логотип производителя), переиспользовать brands нельзя (§3).
--
-- products.designer_id — nullable FK ON DELETE SET NULL: товар может быть без
-- дизайнера, удаление дизайнера НЕ удаляет товары (лишь снимает привязку) — как
-- brand_id (docs/06 §3.3). Также author-ref для будущего product_blocks (§9).
--
-- Аддитивно/идемпотентно: CREATE/ADD ... IF NOT EXISTS, CHECK через DO-блок
-- (pg_constraint), GRANT admik_app, schema_migrations ON CONFLICT.
-- =============================================================================

-- --- Таблица дизайнеров ------------------------------------------------------
CREATE TABLE IF NOT EXISTS designers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            citext      NOT NULL,                      -- ЧПУ персоны, уникален
  name            text        NOT NULL,                      -- ФИО (b_stuff.name)
  country         text,                                      -- страна (b_stuff.country)
  description     text        NOT NULL DEFAULT '',            -- rich-описание (b_stuff.description)
  image_key       text,                                      -- аватар (b_stuff.image); ключ объекта S3/MinIO
  page_image_key  text,                                      -- фото для страницы (b_stuff.page_image)
  video_url       text,                                      -- видео Vimeo/YouTube (b_stuff.video_url)
  socials         jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- соцсети { fb, inst, ... } (b_stuff.soc_*)
  work_count      integer     NOT NULL DEFAULT 0,             -- счётчик работ (b_stuff.work_count)
  is_active       boolean     NOT NULL DEFAULT true,
  sort            integer     NOT NULL DEFAULT 0,
  seo_title       text,
  seo_description text,
  og_title        text,
  og_description  text,
  og_image_key    text,
  canonical_url   text,
  noindex         boolean     NOT NULL DEFAULT false,
  -- Оверлей переводов (ADR-i18n, docs/24 §1): { "<locale>": { name|description|country } }.
  translations    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS designers_slug_uniq  ON designers (slug);
CREATE INDEX        IF NOT EXISTS designers_active_idx ON designers (is_active);

-- CHECK: socials/translations всегда jsonb-объект (не массив/скаляр). ADD CONSTRAINT
-- не поддерживает IF NOT EXISTS → идемпотентность через pg_constraint DO-блок.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'designers_translations_obj_chk'
  ) THEN
    ALTER TABLE designers
      ADD CONSTRAINT designers_translations_obj_chk
      CHECK (jsonb_typeof(translations) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'designers_socials_obj_chk'
  ) THEN
    ALTER TABLE designers
      ADD CONSTRAINT designers_socials_obj_chk
      CHECK (jsonb_typeof(socials) = 'object');
  END IF;
END $$;

-- --- products.designer_id ----------------------------------------------------
-- nullable: товар может быть без дизайнера. ON DELETE SET NULL: удаление
-- дизайнера не удаляет товары, лишь снимает привязку (зеркально brand_id).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS designer_id uuid REFERENCES designers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS products_designer_idx ON products (designer_id);

-- --- Гранты и регистрация миграции ------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON designers TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0047', 'designers')
ON CONFLICT DO NOTHING;
