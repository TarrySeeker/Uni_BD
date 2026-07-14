-- =============================================================================
-- 0049_phase1_additive_fields.sql  (Фаза 1, шаг 8c — батч аддитивных доработок §9)
-- Пять сквозных доработок функционального паритета с eAdmin, все — строго
-- АДДИТИВНЫЕ nullable-колонки (или NOT NULL DEFAULT), обратно совместимые:
-- старый код не знает про новые колонки, существующие строки получают NULL/false.
--
-- Источники (eAdmin прод, read-only, docs/24 §9):
--   • categories.image_key   ← c_catalog.image      (S3-ключ, как og_image_key)
--   • leads.company/city/subject/answer/attachment_key ← b_os_feedback
--     (+ значение source='callback' ← b_os_call; CHECK на source НЕТ — просто текст)
--   • brands.external_url     ← b_brands.url         (внешний сайт бренда)
--   • orders.is_postamat      ← delivery_type=3      (постамат = подвид pvz + флаг)
--
-- НЕ входит в DDL (shop_settings — jsonb key/value, не колонки):
--   • offer_doc / rek_* / email_designers → расширение Zod-схемы legal_entity
--     (lib/settings/schemas.ts), backward-compatible optional-поля, без ALTER.
--
-- Мультитенантность: без tenant_id (ADR-003: 1 магазин = 1 БД).
-- НЕ меняем CHECK orders.delivery_type — постамат моделируется флагом
-- is_postamat (подвид pvz), а не новым значением enum → нет DROP CONSTRAINT,
-- check-migrations.sh проходит без carve-out.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; запись в schema_migrations
-- ON CONFLICT DO NOTHING. Таблично-уровневые GRANT (0005/0011/0012/0030)
-- автоматически покрывают новые колонки — отдельный GRANT не нужен.
-- =============================================================================

-- 1) Картинка категории (§9, «Каталог»). S3-ключ; URL собирает storage.url.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_key text;

-- 2) Поля заявок (§9, b_os_feedback). Все nullable → старые leads не ломаются.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company        text;  -- организация клиента
ALTER TABLE leads ADD COLUMN IF NOT EXISTS city           text;  -- город клиента
ALTER TABLE leads ADD COLUMN IF NOT EXISTS subject        text;  -- тема обращения
ALTER TABLE leads ADD COLUMN IF NOT EXISTS answer         text;  -- ответ оператора
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attachment_key text;  -- S3-ключ вложения

-- 3) Внешний сайт бренда (§9, b_brands.url).
ALTER TABLE brands ADD COLUMN IF NOT EXISTS external_url text;

-- 4) Постамат (§9): подвид pvz с флагом, БЕЗ изменения CHECK delivery_type.
--    NOT NULL DEFAULT false → вставка без значения безопасна (старый код).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_postamat boolean NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version, name)
VALUES ('0049', 'phase1_additive_fields')
ON CONFLICT DO NOTHING;
