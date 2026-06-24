-- =============================================================================
-- 0019_shop_settings.sql  (Этап 5 — подсистема 5.4, пакет 5.D-1)
-- shop_settings — конфигурация магазина из БД (docs/11 §5.4.1/§5.4.2, ADR-013).
--
-- Слой, переводящий стек из env-driven в DB-driven: env = дефолт, строка БД =
-- частичный оверрайд на уровне полей. core-always-on (управляет оверрайдом
-- модулей — не может прятаться за флагом, который сам переключает).
--
-- Модель: одна строка = одна логическая группа (branding/currency/units/
-- contacts/legal_entity/catalog/delivery/orders/module_overrides/seo). value —
-- jsonb-объект, типизированный Zod-схемой ключа (lib/settings/schemas.ts).
-- Деньги в value (delivery.freeDeliveryThreshold) — в КОПЕЙКАХ (int), без float.
--
-- Без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
--
-- Идемпотентно: CREATE TABLE IF NOT EXISTS; CHECK jsonb_typeof через DO-блок +
-- pg_constraint (ALTER ... ADD CONSTRAINT не поддерживает IF NOT EXISTS); GRANT
-- идемпотентен; запись в schema_migrations ON CONFLICT DO NOTHING.
-- DELETE-грант нужен для reset настройки к env-дефолту (resetSetting).
-- =============================================================================

CREATE TABLE IF NOT EXISTS shop_settings (
  setting_key  citext        PRIMARY KEY,           -- ключ раздела (регистронезависим)
  value        jsonb         NOT NULL,              -- полезная нагрузка раздела (объект)
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  updated_by   uuid          REFERENCES users(id) ON DELETE SET NULL  -- audit-trail на строке
);

-- CHECK jsonb_typeof(value) = 'object' идемпотентно (ADD CONSTRAINT без IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shop_settings_value_object_chk'
  ) THEN
    ALTER TABLE shop_settings ADD CONSTRAINT shop_settings_value_object_chk
      CHECK (jsonb_typeof(value) = 'object');
  END IF;
END $$;

-- Полный DML для рантайма приложения. DELETE — для reset к env-дефолту.
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_settings TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0019', 'shop_settings')
ON CONFLICT DO NOTHING;
