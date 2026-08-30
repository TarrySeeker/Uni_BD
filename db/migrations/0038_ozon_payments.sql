-- =============================================================================
-- 0038_ozon_payments.sql — модуль payments/ozon (Ozon Acquiring API 1.0.0)
-- Журнал событий эквайринга Ozon + допуск провайдера ozon на заказе.
--
-- Решение (порт 0027_tbank_payments):
--   * ozon_payment_log — лог входящих POST-уведомлений с ключом идемпотентности,
--     чтобы повторная доставка вебхука не применяла переход дважды;
--   * orders.payment_provider — расширяем CHECK значением ozon. БЕЗ ЭТОГО любая
--     запись провайдера ozon отвергалась бы ограничением из 0027 (там разрешены
--     только tbank и manual) — заказ терял бы связь с платежом.
--
-- КЛЮЧ ИДЕМПОТЕНТНОСТИ: у Ozon нет единого «paymentId» как у Т-Банка — попытка
-- оплаты опознаётся transactionUid (UUID). Ключ (transaction_uid, status): одна
-- попытка может дать несколько событий с разными статусами (Authorized →
-- Completed), но одно и то же событие — ровно один раз.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Расширяем допустимые значения orders.payment_provider значением ozon.
--
-- check-migrations: allow drop-constraint (CHECK нельзя расширить, не пересоздав:
--   два CHECK на колонке действуют по «И», старый отверг бы нового провайдера)
-- ВНИМАНИЕ: ОСОЗНАННОЕ ОТСТУПЛЕНИЕ от правила аддитивности — здесь
-- scripts/check-migrations.sh справедливо ловит DROP CONSTRAINT.
-- Отступление согласовано с владельцем 2026-08-27. Обоснование:
--   * CHECK нельзя РАСШИРИТЬ, не пересоздав: два CHECK на одной колонке действуют
--     по «И», поэтому добавление второго (с ozon) не помогает — старый всё равно
--     отвергнет значение. Проверено экспериментом на этой БД;
--   * правило защищает от снятия инварианта, на который опирается СТАРЫЙ код.
--     Здесь инвариант не снимается, а РАСШИРЯЕТСЯ: перечень допустимых провайдеров
--     дополняется значением, которое пишет только новый код;
--   * снятие и установка идут в ОДНОЙ транзакции (DO-блок) — окна, в котором
--     таблица осталась бы без ограничения, не возникает;
--   * на момент миграции строк с payment_provider IS NOT NULL нет, ограничение
--     помечено NOT VALID и существующие строки не проверяет.
-- Откат: вернуть перечень ('tbank','manual') тем же приёмом.
-- Запуск линтера по этому файлу ожидаемо даёт 1 нарушение — это оно.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_provider_chk') THEN
    ALTER TABLE orders DROP CONSTRAINT orders_payment_provider_chk;
  END IF;

  ALTER TABLE orders
    ADD CONSTRAINT orders_payment_provider_chk
    CHECK (payment_provider IS NULL OR payment_provider IN ('tbank', 'ozon', 'manual'))
    NOT VALID;
END $$;

-- -----------------------------------------------------------------------------
-- ozon_payment_log — лог входящих уведомлений Ozon.
--   raw_payload хранится БЕЗ поля requestSign (подпись вырезается в коде): в
--   журнале она бесполезна, а утечка помогала бы подделывать уведомления.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ozon_payment_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid        NOT NULL,                   -- FK → orders.id (ниже)
  ozon_order_id    text,                                   -- order.id на стороне эквайринга
  transaction_uid  text        NOT NULL,                   -- UUID попытки оплаты (ключ идемпотентности)
  status           text        NOT NULL,                   -- Completed | Rejected | Authorized
  payment_method   text,                                   -- PAY_TYPE_BANK_CARD | PAY_TYPE_SBP | PAY_TYPE_OZON_CARD
  amount_kop       bigint      CHECK (amount_kop IS NULL OR amount_kop >= 0),  -- сумма события, КОПЕЙКИ
  error_code       integer,                                -- errorCode неуспешной попытки
  error_message    text,
  is_test          boolean     NOT NULL DEFAULT false,     -- testMode=1 (тестовый режим токена)
  is_mock          boolean     NOT NULL DEFAULT false,     -- событие локального mock-режима
  raw_payload      jsonb,                                  -- тело без requestSign (аудит)
  processed        boolean     NOT NULL DEFAULT false,     -- применён ли переход payment_status
  ip               text,
  received_at      timestamptz NOT NULL DEFAULT now()
);

-- Ключ идемпотентности: одно событие (попытка + статус) — ровно один раз.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ozon_payment_log_idem
  ON ozon_payment_log (transaction_uid, status);
CREATE INDEX IF NOT EXISTS ix_ozon_payment_log_order ON ozon_payment_log (order_id);
CREATE INDEX IF NOT EXISTS ix_ozon_payment_log_ozon  ON ozon_payment_log (ozon_order_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ozon_payment_log_order_fk') THEN
    ALTER TABLE ozon_payment_log
      ADD CONSTRAINT ozon_payment_log_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Гранты и регистрация миграции.
-- ВАЖНО (урок СВформы): без GRANT приложение падает с permission denied, при этом
-- контейнеры остаются healthy — поломку видно только по 500 на API.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ozon_payment_log TO admik_app;

-- ⚠️ ПЕРЕНУМЕРАЦИЯ 2026-08-30: файл выехал с 0034 на 0038 — номер 0034 занят
-- миграцией личного кабинета (0034_customer_accounts). Магазин, где Ozon был
-- накачен ДО перенумерации, содержит в schema_migrations версию '0034';
-- повторный накат под новым номером безопасен — весь DDL выше идемпотентен
-- (IF NOT EXISTS / пересоздание CHECK в одной транзакции), данные не трогаются.
INSERT INTO schema_migrations (version, name)
VALUES ('0038', 'ozon_payments')
ON CONFLICT DO NOTHING;
