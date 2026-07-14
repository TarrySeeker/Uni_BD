-- =============================================================================
-- 0037_paykeeper_payments.sql  (Фаза 1 — модуль payments/paykeeper, docs/24 §2, ADR-P1-2)
-- Идемпотентный лог событий PayKeeper (порт 0027_tbank_payments на инвойсную модель).
--
-- Решение (docs/24 §2):
--   * PayKeeper — инвойсный эквайер: заказу выставляется счёт (invoice), его id
--     хранится в orders.payment_ref (0012), провайдер — orders.payment_provider
--     (0027, расширяется на 'paykeeper' в 0038). Эта таблица — аудит/replay
--     входящих колбэков и результатов reconcile.
--   * paykeeper_payment_log — лог событий с UNIQUE (invoice_id, status) →
--     идемпотентность повторной доставки колбэка (PayKeeper ретраит до 50 раз):
--     INSERT ... ON CONFLICT DO NOTHING. Зеркало tbank_payment_log (0027).
--   * raw_payload хранится БЕЗ секретного слова/подписи (маскируется в коде).
--
-- Идемпотентно и АДДИТИВНО (проходит scripts/check-migrations.sh):
--   CREATE TABLE/INDEX IF NOT EXISTS, FK через DO-блок + pg_constraint (ALTER ADD
--   CONSTRAINT не поддерживает IF NOT EXISTS), CHECK — инлайн в CREATE TABLE.
--   НЕТ DROP/RENAME/смены типа. Только структура лога (адаптер — следующий под-шаг).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- paykeeper_payment_log — лог входящих событий колбэка/reconcile PayKeeper.
--   КЛЮЧ ИДЕМПОТЕНТНОСТИ (docs/24 §2): одно событие (invoice_id + status) пишется
--   один раз → INSERT ... ON CONFLICT DO NOTHING. Повторная доставка колбэка
--   безопасна (переход payment_status применяется лишь для нового события).
--   Суммы в копейках (bigint) — единый внутренний формат Admik, как в 0027;
--   в рубли PayKeeper конвертирует адаптер (следующий под-шаг).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paykeeper_payment_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL,                      -- FK → orders.id (ниже)
  invoice_id    text        NOT NULL,                      -- id счёта PayKeeper = orders.payment_ref
  status        text        NOT NULL,                      -- нормализованный статус события
  amount_kop    bigint      CHECK (amount_kop IS NULL OR amount_kop >= 0),  -- сумма события, копейки
  is_mock       boolean     NOT NULL DEFAULT false,        -- событие в mock-режиме
  raw_payload   jsonb,                                     -- тело без секрета/подписи (аудит/replay)
  processed     boolean     NOT NULL DEFAULT false,        -- применён ли переход payment_status
  ip            text,                                      -- источник колбэка (опц.)
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- КЛЮЧ ИДЕМПОТЕНТНОСТИ колбэка (docs/24 §2): одно (invoice_id, status) — раз.
CREATE UNIQUE INDEX IF NOT EXISTS uq_paykeeper_payment_log_idem
  ON paykeeper_payment_log (invoice_id, status);
CREATE INDEX IF NOT EXISTS ix_paykeeper_payment_log_order ON paykeeper_payment_log (order_id);
CREATE INDEX IF NOT EXISTS ix_paykeeper_payment_log_inv   ON paykeeper_payment_log (invoice_id);

-- FK на orders (CASCADE: удаление заказа чистит лог платежей). ALTER ADD CONSTRAINT
-- не знает IF NOT EXISTS → идемпотентность через pg_constraint (как в 0027).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paykeeper_payment_log_order_fk'
  ) THEN
    ALTER TABLE paykeeper_payment_log
      ADD CONSTRAINT paykeeper_payment_log_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Гранты и регистрация миграции.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON paykeeper_payment_log TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0037', 'paykeeper_payments')
ON CONFLICT DO NOTHING;
