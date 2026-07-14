-- =============================================================================
-- 0035_i18n_cms_promo.sql  (Фаза 1b — фундамент i18n; ADR-i18n, docs/24 §1)
-- Продолжение i18n-оверлея на CMS-контент и промокоды.
--
-- ПРЕДПОСЫЛКА (ADR-P1-4): i18n-whitelist промокодов ссылается на публичную метку
-- promo_codes.public_label, а базовой колонки не было (был «сиротский whitelist»).
-- Добавляем её ПЕРВЫМ шагом — иначе оверлей переводит несуществующее поле.
-- code/comment намеренно НЕ переводимы (служебные), поэтому в whitelist не входят.
--
-- cms_page_sections.translations несёт СТРУКТУРНЫЙ per-locale контент (тексты
-- внутри секции), резолвится deep-merge'ем поверх базового content; структурные
-- ключи (type/section_key/order) НЕ переводятся (см. lib/i18n localizeStructured).
--
-- Обратная совместимость (§6.4/ADR-015): чисто АДДИТИВНО. Колонки NOT NULL
-- DEFAULT '{}' / nullable text безопасны для уже существующих строк.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; CHECK через DO-блок + pg_constraint;
-- schema_migrations ON CONFLICT DO NOTHING. Таблично-уровневые GRANT покрывают
-- новые колонки автоматически.
-- =============================================================================

-- Предпосылка: публичная метка промокода (база для i18n-whitelist).
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS public_label text;

ALTER TABLE cms_pages         ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE cms_page_sections ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE promo_codes       ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;

-- CHECK (jsonb_typeof(translations) = 'object') на каждую таблицу (см. 0034).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cms_pages', 'cms_page_sections', 'promo_codes']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_translations_obj_chk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (jsonb_typeof(translations) = %L)',
        t, t || '_translations_obj_chk', 'object'
      );
    END IF;
  END LOOP;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('0035', 'i18n_cms_promo')
ON CONFLICT DO NOTHING;
