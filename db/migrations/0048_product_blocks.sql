-- =============================================================================
-- 0048_product_blocks.sql  (Фаза 1 — шаг 8b; docs/24 §9, §10)
-- Порт eAdmin-блока b_work_block (config/blocks/work_block.php) — структурные
-- секции карточки товара. В Admik у товара одно rich-text поле (products.description)
-- → структурный контент карточки (цитата с автором, табы, текст, картинка) терялся.
-- Вводим отдельную таблицу product_blocks: 1 товар → N упорядоченных секций.
--
-- Порт полей b_work_block:
--   • type            ← 'type' (позиция текста/вид секции) → нормализованный enum
--                       ('text','quote','tabs','image');
--   • title           ← 'title'      (заголовок для отображения; ПЕРЕВОДИМО);
--   • blockquot       ← 'blockquot'  (цитата; ПЕРЕВОДИМО);
--   • author_designer_id ← 'stuff_id' (автор цитаты → персона b_stuff → designers);
--   • body            ← 'text'       (rich HTML ckeditor; ПЕРЕВОДИМО);
--   • image_key       ← 'image'      (одиночная картинка секции; КЛЮЧ S3);
--   • tabs jsonb      ← tab_one..four_name/text → массив [{name,text}] (СТРУКТУРНО;
--                       ПЕРЕВОДИМО через i18n-оверлей + localizeStructured, docs/24 §1);
--   • sort            ← 'sort'       (порядок секций внутри товара).
--   ('name' b_work_block — служебная метка «нигде не отображается» — не переносим.)
--
-- FK:
--   • product_id → products(id) ON DELETE CASCADE — секции живут в рамках товара,
--     удаление товара уносит его блоки (как reviews/product_media);
--   • author_designer_id → designers(id) ON DELETE SET NULL — удаление дизайнера
--     не удаляет блок, лишь снимает авторство цитаты (зеркально products.designer_id,
--     0047). designers создана в 0047 (шаг 8a) — FK разрешается.
--
-- i18n (ADR-i18n, docs/24 §1, §9): whitelist плоских полей — title/blockquot/body;
--   табы — СТРУКТУРНЫЙ per-locale оверлей (translations[locale].tabs, deep-merge).
--   Непереводимо: type, author_designer_id, image_key, sort, timestamps.
--
-- Без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
--
-- Идемпотентно/аддитивно (§6.4/ADR-015): CREATE TABLE/INDEX IF NOT EXISTS, CHECK
-- множеств значений — в CREATE TABLE, FK и CHECK jsonb_typeof — через DO-блоки
-- (pg_constraint, т.к. ADD CONSTRAINT не поддерживает IF NOT EXISTS), GRANT
-- идемпотентен, schema_migrations ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_blocks (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         uuid        NOT NULL,                 -- FK→products (CASCADE, ниже)
  type               text        NOT NULL DEFAULT 'text'
                     CHECK (type IN ('text','quote','tabs','image')),  -- вид секции (← 'type')
  title              text,                                  -- заголовок (← title); ПЕРЕВОДИМО
  blockquot          text,                                  -- цитата (← blockquot); ПЕРЕВОДИМО
  author_designer_id uuid,                                  -- автор цитаты (← stuff_id); FK→designers SET NULL
  body               text,                                  -- rich HTML (← text ckeditor); ПЕРЕВОДИМО
  image_key          text,                                  -- одиночная картинка (← image); КЛЮЧ S3
  tabs               jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{name,text}] (← tab_one..four); СТРУКТУРНО
  sort               integer     NOT NULL DEFAULT 0,        -- порядок секции в товаре (← sort)
  -- i18n-оверлей (docs/24 §1): { "<locale>": { title|blockquot|body|tabs } }.
  translations       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Выборка секций товара в порядке отображения (storefront + admin-редактор).
CREATE INDEX IF NOT EXISTS product_blocks_product_sort_idx ON product_blocks (product_id, sort);
-- Обратная связь автор→блоки (кому какие цитаты принадлежат; SET NULL при удалении).
CREATE INDEX IF NOT EXISTS product_blocks_author_idx       ON product_blocks (author_designer_id);

-- FK product_id → products(id) ON DELETE CASCADE (секция живёт в рамках товара).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_blocks_product_id_fkey'
  ) THEN
    ALTER TABLE product_blocks
      ADD CONSTRAINT product_blocks_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
  END IF;
END $$;

-- FK author_designer_id → designers(id) ON DELETE SET NULL (автор — необязателен;
-- удаление персоны снимает авторство, не удаляя блок). Зеркально products.designer_id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_blocks_author_designer_id_fkey'
  ) THEN
    ALTER TABLE product_blocks
      ADD CONSTRAINT product_blocks_author_designer_id_fkey
      FOREIGN KEY (author_designer_id) REFERENCES designers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- CHECK: translations всегда jsonb-объект (не массив/скаляр) — см. 0034/0043/0047.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_blocks_translations_obj_chk'
  ) THEN
    ALTER TABLE product_blocks
      ADD CONSTRAINT product_blocks_translations_obj_chk
      CHECK (jsonb_typeof(translations) = 'object');
  END IF;
END $$;

-- CHECK: tabs всегда jsonb-массив (структурный список секций-табов).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_blocks_tabs_arr_chk'
  ) THEN
    ALTER TABLE product_blocks
      ADD CONSTRAINT product_blocks_tabs_arr_chk
      CHECK (jsonb_typeof(tabs) = 'array');
  END IF;
END $$;

-- Полный DML для рантайма приложения (CRUD секций через Server Actions каталога).
GRANT SELECT, INSERT, UPDATE, DELETE ON product_blocks TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0048', 'product_blocks')
ON CONFLICT DO NOTHING;
