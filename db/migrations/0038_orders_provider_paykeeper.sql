-- =============================================================================
-- 0038_orders_provider_paykeeper.sql  (Фаза 1 — payments/paykeeper, docs/24 §2, §7 ADR-P1-2)
-- Расширение множества значений orders.payment_provider на 'paykeeper'.
--
-- Контекст (docs/24 §2, §7):
--   0027 создала CHECK orders_payment_provider_chk = IN ('tbank','manual') NOT VALID.
--   NOT VALID энфорсится на КАЖДУЮ запись → INSERT/UPDATE с 'paykeeper' отвергается
--   (SQLSTATE 23514). Расширить множество значений в Postgres можно ТОЛЬКО через
--   drop+recreate ограничения — ALTER CONSTRAINT такого не умеет.
--
-- ПОЧЕМУ ЭТО АДДИТИВНО (обоснование carve-out ADR-P1-2):
--   Новое множество — СТРОГИЙ superset прежнего: {'tbank','manual'} ⊂
--   {'tbank','manual','paykeeper'} (+ NULL по-прежнему допустим). Ни одно ранее
--   валидное значение не становится невалидным → старый код, писавший 'tbank'/
--   'manual'/NULL, не ломается. Снятия инварианта нет — множество только РАСШИРЯЕТСЯ.
--   Это единственный безопасный вид DROP CONSTRAINT, и он разрешён линтером ТОЛЬКО
--   при наличии маркера ниже + немедленного ADD CONSTRAINT того же имени с CHECK.
--
-- Идемпотентно: DROP+ADD в одном DO-блоке (одна транзакция) — повторный накат
-- пересоздаёт то же самое ограничение. NOT VALID: не блокирует существующие строки,
-- но энфорсит новое множество на все будущие записи (в т.ч. 'paykeeper').
--
-- check-migrations:allow-widen-check orders_payment_provider_chk superset {'tbank','manual'} + 'paykeeper' (ADR-P1-2, docs/24 §7); NULL по-прежнему допустим, ни одно прежде валидное значение не отвергается.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_provider_chk'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT orders_payment_provider_chk;
  END IF;
  ALTER TABLE orders
    ADD CONSTRAINT orders_payment_provider_chk
    CHECK (payment_provider IS NULL OR payment_provider IN ('tbank', 'manual', 'paykeeper'))
    NOT VALID;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('0038', 'orders_provider_paykeeper')
ON CONFLICT DO NOTHING;
