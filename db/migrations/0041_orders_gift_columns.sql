-- =============================================================================
-- 0041_orders_gift_columns.sql  (Фаза 1 — под-шаг 4a; docs/24 §5, §10)
-- Аддитивная привязка подарочного сертификата к заказу. NULL/DEFAULT 0 — старый
-- код (и существующие заказы) работают без изменений (§6.4/ADR-015).
--
-- ГРАНИЦА 4a: колонки ДОБАВЛЯЮТСЯ (схема), но конвейер quote/createOrder/refund
-- их ещё НЕ заполняет — интеграция в денежные потоки это под-шаг 4b. Здесь только
-- аддитивная схема + FK, чтобы 4b лёг чисто.
--
--   gift_certificate_id  — какой сертификат применён к заказу (снимок связи);
--                          FK → gift_certificates(id) ON DELETE SET NULL (заказ
--                          переживает удаление сертификата, историческая сумма в
--                          gift_discount_total сохраняется).
--   gift_discount_total  — сумма, списанная сертификатом на этот заказ (снимок,
--                          как discount_total промокода); >= 0.
--
-- Идемпотентно/аддитивно: ADD COLUMN IF NOT EXISTS; FK/CHECK через DO-блок.
-- =============================================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_certificate_id uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_discount_total numeric(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  -- gift_discount_total >= 0 (снимок скидки не может быть отрицательным).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_gift_discount_nonneg_chk'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_gift_discount_nonneg_chk
      CHECK (gift_discount_total >= 0);
  END IF;

  -- FK orders.gift_certificate_id → gift_certificates(id) ON DELETE SET NULL.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_gift_certificate_id_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_gift_certificate_id_fkey
      FOREIGN KEY (gift_certificate_id) REFERENCES gift_certificates(id) ON DELETE SET NULL;
  END IF;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('0041', 'orders_gift_columns')
ON CONFLICT DO NOTHING;
