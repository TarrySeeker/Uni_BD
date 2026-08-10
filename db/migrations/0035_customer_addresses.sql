-- =============================================================================
-- 0035_customer_addresses.sql — адресная книга покупателя
-- -----------------------------------------------------------------------------
-- Сохранённые адреса доставки — главная причина, по которой кабинет вообще
-- заводят: постоянный покупатель не должен вводить адрес заново каждый раз.
--
-- Коды города и пункта выдачи хранятся рядом с адресом СОЗНАТЕЛЬНО. Без них
-- «сохранённый адрес» бесполезен: при оформлении пришлось бы заново искать
-- город в справочнике службы доставки и заново выбирать пункт выдачи, то есть
-- ровно то, ради чего адрес и сохраняли. Для магазина без службы доставки эти
-- колонки просто остаются пустыми.
--
-- ON DELETE CASCADE — требование 152-ФЗ, а не удобство: удаление аккаунта обязано
-- уносить и адреса, это персональные данные.
--
-- Идемпотентно: CREATE TABLE / CREATE INDEX — IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS customer_addresses (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label          text        NOT NULL DEFAULT '',   -- как покупатель назвал адрес: «Дом», «Работа»
  recipient_name text        NOT NULL DEFAULT '',
  phone          text        NOT NULL DEFAULT '',
  city           text        NOT NULL DEFAULT '',
  -- Код города в справочнике службы доставки: по названию доставку не рассчитать
  -- (городов-тёзок много), нужен именно код.
  delivery_city_code text,
  address_line   text        NOT NULL DEFAULT '',
  postal_code    text        NOT NULL DEFAULT '',
  -- Код пункта выдачи, если выбран самовывоз (иначе NULL — курьерская доставка).
  pickup_point_code text,
  is_default     boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN customer_addresses.delivery_city_code IS
  'Код города в справочнике службы доставки; NULL — служба доставки не используется';
COMMENT ON COLUMN customer_addresses.pickup_point_code IS
  'Код пункта выдачи при самовывозе; NULL — курьерская доставка';

CREATE INDEX IF NOT EXISTS customer_addresses_customer_idx ON customer_addresses (customer_id);

-- Не более одного адреса «по умолчанию» на покупателя.
--
-- ⚠️ Индекс защищает данные, но НЕ снимает гонку: два одновременных запроса
-- «сделать этот адрес основным» столкнутся здесь ошибкой уникальности и дадут
-- 500 вместо результата. Прикладной слой обязан брать блокировку на покупателя
-- перед снятием прежнего признака (см. lib/customer/repository.ts).
CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_one_default
  ON customer_addresses (customer_id) WHERE is_default;

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_addresses TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0035', 'customer_addresses')
ON CONFLICT DO NOTHING;
