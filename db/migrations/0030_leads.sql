-- =============================================================================
-- 0030_leads.sql  (пост-роадмап — G-09: приём заявок с витрины)
-- leads — сообщения с формы обратной связи витрины (/contacts). Раньше форма была
-- заглушкой и сообщения терялись (аудит docs/18, G-09). Теперь витрина шлёт их на
-- публичный Storefront API (POST /api/storefront/v1/leads), а владелец читает в
-- админке (раздел «Заявки», право orders.read).
--
-- Мультитенантность: без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS; CHECK встроен в CREATE TABLE;
-- GRANT идемпотентен; запись в schema_migrations — ON CONFLICT DO NOTHING.
-- Аддитивно (новая таблица; существующий код не затрагивается).
-- =============================================================================

CREATE TABLE IF NOT EXISTS leads (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text         NOT NULL,
  contact     text         NOT NULL,                 -- email или телефон (как ввёл клиент)
  message     text         NOT NULL,
  source      text         NOT NULL DEFAULT 'contact_form',
  status      text         NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','in_progress','done','spam')),
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);

-- Рантайм приложения: INSERT (витрина), SELECT/UPDATE (админка: чтение + смена статуса).
GRANT SELECT, INSERT, UPDATE ON leads TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0030', 'leads')
ON CONFLICT DO NOTHING;
