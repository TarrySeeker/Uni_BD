-- =============================================================================
-- 0014_promo_codes.sql  (Этап 3 — модуль orders)
-- promo_codes — промокоды (docs/07 §2.5, §3): percent / fixed / free_delivery /
--   bogo («N по M» — модель-задел, исполнение Этап 5.2). Лимиты (всего/на
--   покупателя), срок, мин.сумма, потолок скидки. Накладываются ПОВЕРХ итога
--   (после каталожной скидки compare_at_price, ADR-009).
--
-- Также: достраиваем FK orders.promo_code_id → promo_codes(id) ON DELETE SET NULL
--   (объявление отложено из 0012 — лексикографический порядок наката).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, DO-блок (pg_constraint),
--   ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS promo_codes (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  code            citext        NOT NULL,                  -- сам код (регистронезависим), уникален

  -- Тип скидки промокода:
  kind            text          NOT NULL
                  CHECK (kind IN ('percent','fixed','free_delivery','bogo')),
  -- value: percent — проценты (0..100); fixed — сумма скидки; free_delivery —
  --        игнорируется (скидка = стоимость доставки); bogo — см. bogo_* (задел).
  value           numeric(14,2) NOT NULL DEFAULT 0 CHECK (value >= 0),

  -- ---- Условия применения ----
  min_order_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (min_order_total >= 0),
  max_discount    numeric(14,2) CHECK (max_discount IS NULL OR max_discount >= 0),

  -- ---- Лимиты использования (идемпотентность через promo_redemptions, §3.4) ----
  usage_limit         integer   CHECK (usage_limit IS NULL OR usage_limit >= 0),
  per_customer_limit  integer   CHECK (per_customer_limit IS NULL OR per_customer_limit >= 0),
  used_count          integer   NOT NULL DEFAULT 0 CHECK (used_count >= 0),

  -- ---- Срок и активность ----
  starts_at       timestamptz,
  ends_at         timestamptz,
  is_active       boolean       NOT NULL DEFAULT true,

  -- ---- Задел под BOGO «N по M» / «3 по 2» (исполнение — Этап 5.2) ----
  bogo_buy_qty    integer       CHECK (bogo_buy_qty IS NULL OR bogo_buy_qty > 0),
  bogo_pay_qty    integer       CHECK (bogo_pay_qty IS NULL OR bogo_pay_qty > 0),

  comment         text          NOT NULL DEFAULT '',
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT promo_dates_chk CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_uniq  ON promo_codes (code);
CREATE INDEX        IF NOT EXISTS promo_codes_active_idx ON promo_codes (is_active) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON promo_codes TO admik_app;

-- FK orders.promo_code_id → promo_codes(id) (объявление отложено из 0012):
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_promo_code_id_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_promo_code_id_fkey
      FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE SET NULL;
  END IF;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('0014', 'promo_codes')
ON CONFLICT DO NOTHING;
