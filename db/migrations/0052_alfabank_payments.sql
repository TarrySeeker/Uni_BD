-- =============================================================================
-- 0052_alfabank_payments.sql  (Фаза 1 — модуль payments/alfabank, порт 0037)
-- Идемпотентный лог событий Альфа-Банка (порт 0037_paykeeper_payments на модель RBS).
--
-- Решение (порт 0037):
--   * Альфа-Банк (RBS) — эквайер с регистрацией заказа: заказу регистрируется платёж
--     (register.do), его orderId хранится в orders.payment_ref (0012), провайдер —
--     orders.payment_provider (0027, расширяется на 'alfabank' в 0051). Эта таблица —
--     аудит/replay входящих колбэков (callbackUrl) и результатов reconcile.
--   * alfabank_payment_log — лог событий с UNIQUE (order_ref, status) →
--     идемпотентность повторной доставки колбэка: INSERT ... ON CONFLICT DO NOTHING.
--     Зеркало tbank_payment_log (0027) / paykeeper_payment_log (0037).
--   * raw_payload хранится БЕЗ checksum/секрета (маскируется в коде).
--
-- Идемпотентно и АДДИТИВНО (проходит scripts/check-migrations.sh):
--   CREATE TABLE/INDEX IF NOT EXISTS, FK через DO-блок + pg_constraint (ALTER ADD
--   CONSTRAINT не поддерживает IF NOT EXISTS), CHECK — инлайн в CREATE TABLE.
--   НЕТ DROP/RENAME/смены типа.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- alfabank_payment_log — лог входящих событий колбэка/reconcile Альфа-Банка.
--   КЛЮЧ ИДЕМПОТЕНТНОСТИ: одно событие (order_ref + status) пишется один раз →
--   INSERT ... ON CONFLICT DO NOTHING. Повторная доставка колбэка безопасна
--   (переход payment_status применяется лишь для нового события). Суммы в копейках
--   (bigint) — единый внутренний формат Admik, как в 0027/0037.
--   order_ref = orderId Альфа-Банка (mdOrder) = orders.payment_ref.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alfabank_payment_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL,                      -- FK → orders.id (ниже)
  order_ref     text        NOT NULL,                      -- orderId Альфа-Банка (mdOrder) = orders.payment_ref
  status        text        NOT NULL,                      -- нормализованный статус события
  amount_kop    bigint      CHECK (amount_kop IS NULL OR amount_kop >= 0),  -- сумма события, копейки
  is_mock       boolean     NOT NULL DEFAULT false,        -- событие в mock-режиме
  raw_payload   jsonb,                                     -- тело без checksum/секрета (аудит/replay)
  processed     boolean     NOT NULL DEFAULT false,        -- применён ли переход payment_status
  ip            text,                                      -- источник колбэка (опц.)
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- КЛЮЧ ИДЕМПОТЕНТНОСТИ колбэка: одно (order_ref, status) — раз.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alfabank_payment_log_idem
  ON alfabank_payment_log (order_ref, status);
CREATE INDEX IF NOT EXISTS ix_alfabank_payment_log_order ON alfabank_payment_log (order_id);
CREATE INDEX IF NOT EXISTS ix_alfabank_payment_log_ref   ON alfabank_payment_log (order_ref);

-- FK на orders (CASCADE: удаление заказа чистит лог платежей). ALTER ADD CONSTRAINT
-- не знает IF NOT EXISTS → идемпотентность через pg_constraint (как в 0027/0037).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'alfabank_payment_log_order_fk'
  ) THEN
    ALTER TABLE alfabank_payment_log
      ADD CONSTRAINT alfabank_payment_log_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Гранты и регистрация миграции.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON alfabank_payment_log TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0052', 'alfabank_payments')
ON CONFLICT DO NOTHING;
