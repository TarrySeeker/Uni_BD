-- =============================================================================
-- 0031_newsletter_subscribers.sql  (пост-роадмап — G-12: подписка на рассылку)
-- newsletter_subscribers — email-подписчики из формы в футере витрины. Раньше
-- форма была заглушкой и подписки нигде не сохранялись (аудит docs/18, G-12).
--
-- email — citext UNIQUE (повторная подписка идемпотентна: ON CONFLICT DO NOTHING).
-- Мультитенантность: без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS; CHECK встроен в CREATE TABLE;
-- GRANT идемпотентен; schema_migrations — ON CONFLICT DO NOTHING. Аддитивно.
-- =============================================================================

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext       NOT NULL UNIQUE,
  status      text         NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','unsubscribed')),
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS newsletter_subscribers_created_at_idx
  ON newsletter_subscribers (created_at DESC);

GRANT SELECT, INSERT, UPDATE ON newsletter_subscribers TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0031', 'newsletter_subscribers')
ON CONFLICT DO NOTHING;
