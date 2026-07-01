-- =============================================================================
-- 0033_cms_pages_og_text.sql  (бэклог C18 — OG-текст CMS-страницы до БД/витрины)
-- og_title / og_description на cms_pages (docs/20 §C18, docs/11 §5.3).
--
-- Форма CMS-страницы и универсальный <SeoFieldset> уже показывают поля «OG-
-- заголовок»/«OG-описание» (как карточки товара/бренда), но у cms_pages не было
-- колонок — заполненные значения молча терялись. Добавляем недостающее, чтобы
-- og-текст страницы доходил до БД и витрины (pageMeta → buildSeoMeta).
--
-- Те же примитивы, что у каталога (0021_seo_entity_fields: products/categories/
-- brands.og_title/og_description) — единый контракт, без хардкода под один ИМ.
--
-- Идемпотентно/аддитивно: ADD COLUMN IF NOT EXISTS (пройдёт линтер аддитивности
-- scripts/check-migrations.sh). GRANT не нужен: права на cms_pages выданы в 0022,
-- новые столбцы наследуют табличные привилегии роли admik_app. Запись в
-- schema_migrations — ON CONFLICT DO NOTHING.
-- =============================================================================

ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS og_title       text;
ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS og_description text;

-- GRANT не нужен: права на cms_pages выданы в 0022, новые столбцы наследуют
-- табличные привилегии роли admik_app.

INSERT INTO schema_migrations (version, name)
VALUES ('0033', 'cms_pages_og_text')
ON CONFLICT DO NOTHING;
