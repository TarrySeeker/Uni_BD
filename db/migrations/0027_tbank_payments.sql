-- =============================================================================
-- 0027_tbank_payments.sql  (Этап 7 — модуль payments/tbank, docs/15 §4.4, ADR-017)
-- Провайдер платежа на заказе + идемпотентный лог webhook Т-Банка.
--
-- Решение (docs/15 §4.4, ADR-017):
--   * orders.payment_provider — НОВОЕ опциональное поле: различает провайдеров
--     онлайн-оплаты ('tbank' и будущие) ортогонально payment_method (card/sbp).
--     NULL = провайдер не задан (оплата при получении / выставление счёта) —
--     поведение до Этапа 7 сохранено;
--   * tbank_payment_log — лог входящих событий webhook с UNIQUE
--     (payment_id, status) → идемпотентность повторной доставки (INSERT ... ON
--     CONFLICT DO NOTHING). Порт cdek_status_log (0017).
--
-- Идемпотентно и АДДИТИВНО (проходит scripts/check-migrations.sh):
--   ADD COLUMN IF NOT EXISTS (nullable, без DROP/RENAME/типа), CREATE TABLE/INDEX
--   IF NOT EXISTS, FK через DO-блок + pg_constraint (ALTER ADD CONSTRAINT не
--   поддерживает IF NOT EXISTS). CHECK — инлайн в CREATE TABLE / через pg_constraint.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- orders.payment_provider — провайдер онлайн-оплаты (docs/15 §4.4). NULLABLE,
-- без DEFAULT/NOT NULL — аддитивно, старый код не ломается. PaymentId Т-Банка
-- по-прежнему хранится в orders.payment_ref (0012), новая таблица — для аудита.
-- -----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider text;

-- CHECK-ограничение значений провайдера (NOT VALID — расширение, не блокирует
-- старые строки; NULL допустим). Через pg_constraint (нет IF NOT EXISTS у ADD).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_provider_chk'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_payment_provider_chk
      CHECK (payment_provider IS NULL OR payment_provider IN ('tbank', 'manual'))
      NOT VALID;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- tbank_payment_log — лог входящих событий webhook Т-Банка (порт cdek_status_log).
--   КЛЮЧ ИДЕМПОТЕНТНОСТИ (docs/15 §4.2, §7): одно событие (payment_id + status)
--   пишется один раз → INSERT ... ON CONFLICT DO NOTHING. Повторная доставка
--   webhook безопасна (переход применяется лишь для нового события).
--   raw_payload хранится БЕЗ Token/PAN (маскируется в коде, docs/15 §7).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tbank_payment_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL,                      -- FK → orders.id (ниже)
  payment_id    text        NOT NULL,                      -- PaymentId Т-Банка
  status        text        NOT NULL,                      -- Status Т-Банка (NEW/CONFIRMED/…)
  amount_kop    bigint      CHECK (amount_kop IS NULL OR amount_kop >= 0),  -- сумма события, копейки
  is_mock       boolean     NOT NULL DEFAULT false,        -- событие в mock-режиме
  raw_payload   jsonb,                                     -- тело без Token/PAN (аудит/replay)
  processed     boolean     NOT NULL DEFAULT false,        -- применён ли переход payment_status
  ip            text,                                      -- источник webhook (опц.)
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- КЛЮЧ ИДЕМПОТЕНТНОСТИ webhook (docs/15 §4.2): одно (payment_id, status) — раз.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tbank_payment_log_idem
  ON tbank_payment_log (payment_id, status);
CREATE INDEX IF NOT EXISTS ix_tbank_payment_log_order ON tbank_payment_log (order_id);
CREATE INDEX IF NOT EXISTS ix_tbank_payment_log_pay   ON tbank_payment_log (payment_id);

-- FK на orders (CASCADE: удаление заказа чистит лог платежей).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tbank_payment_log_order_fk'
  ) THEN
    ALTER TABLE tbank_payment_log
      ADD CONSTRAINT tbank_payment_log_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Гранты и регистрация миграции.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON tbank_payment_log TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0027', 'tbank_payments')
ON CONFLICT DO NOTHING;
