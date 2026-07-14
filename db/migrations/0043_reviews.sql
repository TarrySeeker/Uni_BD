-- =============================================================================
-- 0043_reviews.sql  (Фаза 1 — шаг 6; docs/24 §4, §10)
-- Отзывы с рейтингом — вертикальный срез по эталону lib/leads + рейтинг + FK на
-- товар/покупателя. Порт eAdmin-блока «Комментарии» (config/blocks/comments.php:
-- автор name, профиль user_id, дата, ckeditor-текст, рейтинг 0..4, модерация
-- visible, привязка thread_id).
--
-- Отличия модели от eAdmin (нормализация под Admik):
--   • id int → uuid;
--   • rating 0..4 → СТАНДАРТНЫЙ 1..5 (CHECK). Маппинг старого 0..4→1..5 и
--     семантика значения 0 — ETL-ВОПРОС ФАЗЫ 3 (b_comments НЕТ в дампе схемы,
--     наличие данных подтверждается read-only SELECT). ЗДЕСЬ НЕ РЕШАЕТСЯ.
--   • visible tinyint → status-триада pending/approved/rejected (модерация как
--     статус-машина, а не тумблер);
--   • thread_id → product_id (FK, обязателен — отзыв без товара бессмыслен);
--   • user_id → customer_id (FK, nullable — гость);
--   • date (unix) → created_at; ответ магазина reply — переводимо (i18n-оверлей).
--
-- i18n (ADR-i18n, docs/24 §1, §4): переводим ТОЛЬКО reply (ответ магазина). UGC —
--   author_name/body — НЕ переводим (по ADR). Whitelist = ['reply'].
--
-- Без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
--
-- Идемпотентно/аддитивно (§6.4/ADR-015): CREATE TABLE/INDEX IF NOT EXISTS, CHECK
-- множеств значений встроены в CREATE TABLE, FK и CHECK jsonb_typeof — через
-- DO-блоки (pg_constraint, т.к. ADD CONSTRAINT не поддерживает IF NOT EXISTS),
-- GRANT идемпотентен, schema_migrations ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reviews (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid          NOT NULL,                    -- FK→products (CASCADE, ниже); обязателен
  customer_id   uuid,                                       -- FK→customers (SET NULL, ниже); NULL — гость
  author_name   text          NOT NULL,                     -- UGC (← name); НЕ переводимо
  body          text          NOT NULL,                     -- UGC (← text ckeditor → plain, санитайз); НЕ переводимо
  rating        smallint      NOT NULL CHECK (rating BETWEEN 1 AND 5),  -- стандарт 1..5 (← 0..4, ETL Фаза 3)

  status        text          NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),    -- модерация (← visible)
  reply         text,                                       -- ответ магазина; ПЕРЕВОДИМО (whitelist ['reply'])
  is_verified   boolean       NOT NULL DEFAULT false,       -- подтверждённая покупка (задел)
  source        text          NOT NULL DEFAULT 'storefront',-- канал поступления

  translations  jsonb         NOT NULL DEFAULT '{}'::jsonb, -- i18n-оверлей: ТОЛЬКО reply (UGC не переводим)

  created_at    timestamptz   NOT NULL DEFAULT now(),       -- поступление (← date unix→timestamptz)
  published_at  timestamptz,                                -- момент одобрения (проставляется при approved)
  moderated_at  timestamptz,                                -- когда промодерирован
  moderated_by  uuid          REFERENCES users(id) ON DELETE SET NULL  -- кто промодерировал (админ)
);

-- Витринная выборка одобренных по товару + очередь модерации по товару.
CREATE INDEX IF NOT EXISTS reviews_product_status_idx ON reviews (product_id, status);
-- Очередь модерации: только ожидающие, свежие выше (частичный индекс — компактен).
CREATE INDEX IF NOT EXISTS reviews_pending_idx        ON reviews (created_at DESC) WHERE status = 'pending';
-- Общая лента модерации по дате.
CREATE INDEX IF NOT EXISTS reviews_created_idx         ON reviews (created_at DESC);

-- FK product_id → products(id) ON DELETE CASCADE (отзыв без товара бессмыслен).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_product_id_fkey'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
  END IF;
END $$;

-- FK customer_id → customers(id) ON DELETE SET NULL (отзыв гостя переживает удаление профиля).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_customer_id_fkey'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- CHECK (jsonb_typeof(translations) = 'object') — оверлей всегда объект (см. 0034/0042).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_translations_obj_chk'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_translations_obj_chk
      CHECK (jsonb_typeof(translations) = 'object');
  END IF;
END $$;

-- Полный DML для рантайма приложения (submit с витрины + модерация через Server Actions).
GRANT SELECT, INSERT, UPDATE, DELETE ON reviews TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0043', 'reviews')
ON CONFLICT DO NOTHING;
