-- =============================================================================
-- 0015_promo_redemptions.sql  (Этап 3 — модуль orders)
-- promo_redemptions — факты применения промокода (docs/07 §2.6, §3.4):
--   лимиты (всего/на покупателя) и идемпотентность применения. Один промокод
--   применяется к заказу не более раза (UNIQUE(promo_code_id, order_id)).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id    uuid          NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  order_id         uuid          NOT NULL REFERENCES orders(id)      ON DELETE CASCADE,
  customer_email   citext        NOT NULL,                  -- для per_customer_limit
  discount_applied numeric(14,2) NOT NULL CHECK (discount_applied >= 0),
  created_at       timestamptz   NOT NULL DEFAULT now()
);
-- Один промокод применяется к заказу не более раза (идемпотентность):
CREATE UNIQUE INDEX IF NOT EXISTS promo_redemptions_order_uniq
  ON promo_redemptions (promo_code_id, order_id);
CREATE INDEX IF NOT EXISTS promo_redemptions_email_idx
  ON promo_redemptions (promo_code_id, customer_email);

GRANT SELECT, INSERT, UPDATE, DELETE ON promo_redemptions TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0015', 'promo_redemptions')
ON CONFLICT DO NOTHING;
