-- =============================================================================
-- 0034_i18n_catalog.sql  (Фаза 1b — фундамент i18n; ADR-i18n, docs/24 §1)
-- Сквозной i18n-слой стратегией jsonb-оверлея: на каждую переводимую таблицу
-- каталога аддитивно добавляется ОДНА колонка `translations jsonb`. Базовые
-- NOT NULL-колонки (name/description/seo_*) остаются каноном языка по умолчанию
-- (для carre = ru); не-дефолтные языки живут в оверлее вида
--   {"en":{"name":"Silk scarf",...},"fr":{...}}.
-- База (ru) в оверлей НЕ дублируется. Резолв — на границе (storefront-DTO/форма
-- админки) по цепочке запрошенный→default(ru)→null (см. lib/i18n).
--
-- Обратная совместимость (§6.4/ADR-015): чисто АДДИТИВНО — старый код читает
-- базовые колонки и не знает про translations. Колонка NOT NULL DEFAULT '{}'
-- безопасна: существующие строки получают пустой объект.
--
-- Мультитенантность: без tenant_id (ADR-003: 1 магазин = 1 БД). Набор языков —
-- из настроек (shop_settings.i18n, миграция 0036), а не хардкод.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; CHECK jsonb_typeof через DO-блок +
-- pg_constraint (ALTER ... ADD CONSTRAINT не поддерживает IF NOT EXISTS), как в
-- 0019_shop_settings; запись в schema_migrations ON CONFLICT DO NOTHING.
-- Таблично-уровневые GRANT (0001..0018) автоматически покрывают новую колонку —
-- отдельный GRANT не нужен.
-- =============================================================================

ALTER TABLE products         ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE categories       ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE brands           ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE attributes       ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE attribute_values ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;

-- CHECK (jsonb_typeof(translations) = 'object') на каждую таблицу. Оверлей — это
-- всегда объект (locale → {field → value}); массив/скаляр запрещены. Идемпотентно
-- через pg_constraint (ALTER ... ADD CONSTRAINT не знает IF NOT EXISTS).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'products', 'product_variants', 'categories', 'brands', 'attributes', 'attribute_values'
  ]
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
VALUES ('0034', 'i18n_catalog')
ON CONFLICT DO NOTHING;
