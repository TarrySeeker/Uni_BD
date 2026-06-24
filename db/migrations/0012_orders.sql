-- =============================================================================
-- 0012_orders.sql  (Этап 3 — модуль orders)
-- Единая модель заказа (ADR-002, без «трёх таблиц заявок»): orders + order_items
--   + order_status_history. Позиции — снимок каталога (ADR-010). Деньги numeric(14,2).
-- Поля доставки/оплаты заложены под Этап 4 (СДЭК) и будущую онлайн-оплату — без интеграций.
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- CHECK-ограничения объявляются ИНЛАЙН внутри CREATE TABLE IF NOT EXISTS (таблица
--   создаётся один раз — повторный накат тело не трогает), как в 0006/0010.
--
-- ВНИМАНИЕ к порядку наката (лексикографический, scripts/init-shop.sh):
--   orders ссылается на customers (0013) и promo_codes (0014), которые создаются
--   ПОЗЖЕ. Поэтому здесь столбцы customer_id/promo_code_id создаются БЕЗ FK, а сами
--   внешние ключи добавляются идемпотентно в 0013/0014 (DO-блок + pg_constraint).
--   Так миграции остаются накатываемыми в один проход и идемпотентными.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- orders (§2.1) — заголовок заказа. Суммы numeric(14,2), считаются СЕРВЕРОМ.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Человекочитаемый уникальный номер (нумератор §2.7): напр. 'GA-2026-000123'.
  number            text          NOT NULL,

  -- Статус-машина заказа (§2.8 A). CHECK перечисляет допустимые значения.
  status            text          NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','awaiting_payment','paid','packed',
                                      'shipped','delivered','completed','cancelled','refunded')),

  -- ---- Суммы (numeric(14,2), считаются СЕРВЕРОМ при создании, ADR-010) ----
  items_total       numeric(14,2) NOT NULL CHECK (items_total       >= 0),
  discount_total    numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  delivery_total    numeric(14,2) NOT NULL DEFAULT 0 CHECK (delivery_total >= 0),
  grand_total       numeric(14,2) NOT NULL CHECK (grand_total       >= 0),
  currency          text          NOT NULL DEFAULT 'RUB',

  -- ---- Оплата (онлайн-провайдеры — будущее; сейчас фиксация способа+статуса, mock) ----
  payment_method    text          NOT NULL DEFAULT 'unset'
                    CHECK (payment_method IN ('unset','cod','card','sbp','cdek_pay','invoice')),
  payment_status    text          NOT NULL DEFAULT 'pending'
                    CHECK (payment_status IN ('pending','authorized','paid','failed','refunded')),
  paid_at           timestamptz,
  payment_ref       text,

  -- ---- Доставка (поля под СДЭК Этапа 4; сама интеграция — Этап 4, §7) ----
  delivery_type     text          NOT NULL DEFAULT 'courier'
                    CHECK (delivery_type IN ('courier','pvz','pickup')),
  delivery_status   text          NOT NULL DEFAULT 'pending'
                    CHECK (delivery_status IN ('pending','registered','in_transit','delivered','returned','cancelled')),
  delivery_city     text,
  delivery_address  text,
  delivery_pvz_code text,
  delivery_cost     numeric(14,2) CHECK (delivery_cost IS NULL OR delivery_cost >= 0),
  cdek_uuid         text,
  cdek_track        text,

  -- ---- Промокод (денормализованный код + ссылка; FK добавляется в 0014) ----
  promo_code_id     uuid,
  promo_code        text,

  -- ---- Покупатель (гостевой чекаут — контакты в заказе; FK customer_id в 0013) ----
  customer_id       uuid,
  customer_name     text          NOT NULL,
  customer_email    citext        NOT NULL,
  customer_phone    text          NOT NULL,

  comment           text          NOT NULL DEFAULT '',

  -- ---- Идемпотентность создания (anti-double-submit, §4.2) ----
  idempotency_key   text,

  -- ---- Метки времени и происхождение ----
  source            text          NOT NULL DEFAULT 'storefront'
                    CHECK (source IN ('storefront','admin')),
  ip                text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

-- Уникальность человекочитаемого номера:
CREATE UNIQUE INDEX IF NOT EXISTS orders_number_uniq ON orders (number);
-- Идемпотентность создания заказа витриной (partial — NULL не конфликтует):
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_uniq
  ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Фильтры/сортировки админки:
CREATE INDEX IF NOT EXISTS orders_status_idx  ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_email_idx   ON orders (customer_email);
CREATE INDEX IF NOT EXISTS orders_promo_idx   ON orders (promo_code_id);
CREATE INDEX IF NOT EXISTS orders_payment_idx ON orders (payment_status);

GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO admik_app;

-- -----------------------------------------------------------------------------
-- order_items (§2.2) — позиции заказа = снимок каталога на момент покупки (ADR-010).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- Ссылки на каталог (аналитика/повторный заказ); НЕ источник цены/имени в истории:
  product_id    uuid          REFERENCES products(id)         ON DELETE SET NULL,
  variant_id    uuid          REFERENCES product_variants(id) ON DELETE SET NULL,

  -- ---- СНИМОК на момент заказа (ADR-010): изменение каталога не меняет историю ----
  name_snapshot       text          NOT NULL,
  sku_snapshot        text          NOT NULL,
  attributes_snapshot jsonb         NOT NULL DEFAULT '{}'::jsonb,
  unit_price          numeric(14,2) NOT NULL CHECK (unit_price          >= 0),
  compare_at_snapshot numeric(14,2) CHECK (compare_at_snapshot IS NULL OR compare_at_snapshot >= 0),

  quantity      integer       NOT NULL CHECK (quantity > 0),
  line_total    numeric(14,2) NOT NULL CHECK (line_total >= 0),

  created_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);
CREATE INDEX IF NOT EXISTS order_items_variant_idx ON order_items (variant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON order_items TO admik_app;

-- -----------------------------------------------------------------------------
-- order_status_history (§2.3) — доменная лента смен статуса (заказ/оплата/доставка).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_status_history (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind          text        NOT NULL DEFAULT 'order'
                CHECK (kind IN ('order','payment','delivery')),
  from_status   text,
  to_status     text        NOT NULL,
  actor_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  comment       text        NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_status_history_order_idx ON order_status_history (order_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON order_status_history TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0012', 'orders')
ON CONFLICT DO NOTHING;
