-- =============================================================================
-- 0013_customers.sql  (Этап 3 — модуль orders)
-- customers — ЗАДЕЛ под покупательский ЛК/отслеживание (docs/07 §2.4). Базовый
--   сценарий Этапа 3 — гостевой чекаут (контакты прямо в orders); таблица
--   существует всегда, наполняется по необходимости (upsert по email).
--   Без пароля (аутентификация покупателя — будущий под-модуль/витрина).
--
-- Также: достраиваем FK orders.customer_id → customers(id) ON DELETE SET NULL.
--   FK не объявлен в 0012, т.к. customers создаётся позже (лексикографический
--   порядок наката). Добавляем идемпотентно через DO-блок (pg_constraint),
--   т.к. ALTER TABLE ... ADD CONSTRAINT не поддерживает IF NOT EXISTS.
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext        NOT NULL,                 -- ключ агрегации заказов гостя
  phone        text,
  name         text          NOT NULL DEFAULT '',
  -- Денормализованные агрегаты (опц., пересчёт при создании заказа) — для админки/ЛК:
  orders_count integer       NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
  total_spent  numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_spent >= 0),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_uniq ON customers (email);

GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO admik_app;

-- FK orders.customer_id → customers(id) (объявление отложено из 0012):
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_customer_id_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);

INSERT INTO schema_migrations (version, name)
VALUES ('0013', 'customers')
ON CONFLICT DO NOTHING;
