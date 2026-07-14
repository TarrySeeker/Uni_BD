-- =============================================================================
-- 0040_gift_certificate_redemptions.sql  (Фаза 1 — под-шаг 4a; docs/24 §5, §10)
-- Леджер списаний подарочного сертификата (образец 0015_promo_redemptions +
-- идемпотентность tbank). Одна строка = факт списания части номинала на заказ.
--
-- Инвариант согласованности с денормализованным gift_certificates.spent_total:
--   spent_total = Σ(amount WHERE reversed_at IS NULL).
-- Частичное списание по НЕСКОЛЬКИМ заказам = несколько строк одного certificate_id.
--
-- Идемпотентность: UNIQUE (certificate_id, order_id) — повторный сабмит одного
-- заказа (Idempotency-Key) не декрементит баланс дважды (INSERT ... ON CONFLICT
-- DO NOTHING в redeemGiftTx). Возврат — reversed_at (releaseGiftTx уменьшает
-- spent_total и метит строку; идемпотентно по reversed_at IS NULL).
--
-- Идемпотентно/аддитивно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS gift_certificate_redemptions (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id  uuid          NOT NULL REFERENCES gift_certificates(id) ON DELETE CASCADE,
  order_id        uuid          NOT NULL REFERENCES orders(id)            ON DELETE CASCADE,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),            -- списано на этот заказ; строго > 0
  reversed_at     timestamptz,                                          -- заполняется при рефанде (возврат баланса)
  created_at      timestamptz   NOT NULL DEFAULT now()
);

-- Идемпотентность списания: один сертификат списывается на заказ не более раза.
CREATE UNIQUE INDEX IF NOT EXISTS gift_cert_redemptions_order_uniq
  ON gift_certificate_redemptions (certificate_id, order_id);
-- Обход леджера сертификата (сумма списаний, история в карточке).
CREATE INDEX IF NOT EXISTS gift_cert_redemptions_cert_idx
  ON gift_certificate_redemptions (certificate_id);
-- Возврат по заказу (releaseGiftTx ищет строки заказа).
CREATE INDEX IF NOT EXISTS gift_cert_redemptions_order_idx
  ON gift_certificate_redemptions (order_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON gift_certificate_redemptions TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0040', 'gift_certificate_redemptions')
ON CONFLICT DO NOTHING;
