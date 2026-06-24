-- =============================================================================
-- 0017_cdek_shipments.sql  (Этап 4 — модуль cdek, пакет A)
-- Хранение отправлений СДЭК и лог статусов webhook с идемпотентностью
-- (docs/08 §3.1, порт carre m260524_190100_create_cdek_status_log).
--
-- Решение (ADR-002 «единая модель запроса, не 3 таблицы»):
--   * cdek_shipments — одно отправление на заказ (1:1), вынесено отдельно от
--     orders; поля orders.cdek_uuid/cdek_track (0012) остаются денормализованными
--     «горячими» полями для списков/витрины;
--   * cdek_status_log — лог входящих событий с UNIQUE (cdek_uuid, status_code,
--     status_date_time) → идемпотентность повторных webhook (INSERT ... ON
--     CONFLICT DO NOTHING).
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- ON CONFLICT DO NOTHING. CHECK-ограничения объявлены ИНЛАЙН в CREATE TABLE
-- (таблица создаётся один раз — повторный накат тело не трогает), как в 0012.
-- FK добавляются отложенно через DO-блок + pg_constraint (ALTER ... ADD
-- CONSTRAINT не поддерживает IF NOT EXISTS).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- cdek_shipments (§3.1) — отправление СДЭК, 1:1 к заказу.
--   * cdek_uuid/cdek_number NULL до фактического создания отправления в СДЭК;
--   * вес/габариты — снимок на момент создания (вес в граммах, габариты в см);
--   * delivery_sum — стоимость доставки numeric(14,2);
--   * is_mock — создано в mock-режиме (нет боевых ключей CDEK_ACCOUNT/SECRET);
--   * retry_count — попыток создания (kill-switch при >= max).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdek_shipments (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid          NOT NULL,                       -- FK → orders.id (добавляется ниже)

  cdek_uuid       text,                                         -- UUID отправления в СДЭК (NULL до создания)
  cdek_number     text,                                         -- трек-номер (cdek_number)
  tariff_code     integer,                                      -- код тарифа
  pvz_code        text,                                         -- код ПВЗ назначения
  city_code       integer,                                      -- код города получателя
  delivery_mode   text,                                         -- pvz | postamat | door

  weight_g        integer       CHECK (weight_g IS NULL OR weight_g >= 0),
  length_cm       integer       CHECK (length_cm IS NULL OR length_cm >= 0),
  width_cm        integer       CHECK (width_cm  IS NULL OR width_cm  >= 0),
  height_cm       integer       CHECK (height_cm IS NULL OR height_cm >= 0),

  delivery_sum    numeric(14,2) CHECK (delivery_sum IS NULL OR delivery_sum >= 0),

  status_code     text,                                         -- последний код СДЭК
  status_name     text,                                         -- displayName
  status_at       timestamptz,                                  -- время последнего статуса

  print_url       text,                                         -- URL последней накладной/ШК (опц.)
  is_mock         boolean       NOT NULL DEFAULT false,         -- создано в mock-режиме
  error           text,                                         -- последняя ошибка СДЭК
  retry_count     smallint      NOT NULL DEFAULT 0,             -- попыток создания

  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- FK на orders (создан в 0012) добавляем отложенно и идемпотентно.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cdek_shipments_order_fk'
  ) THEN
    ALTER TABLE cdek_shipments
      ADD CONSTRAINT cdek_shipments_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Одно отправление на заказ (1:1).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cdek_shipments_order  ON cdek_shipments (order_id);
CREATE INDEX        IF NOT EXISTS ix_cdek_shipments_uuid   ON cdek_shipments (cdek_uuid);
CREATE INDEX        IF NOT EXISTS ix_cdek_shipments_number ON cdek_shipments (cdek_number);
CREATE INDEX        IF NOT EXISTS ix_cdek_shipments_status ON cdek_shipments (status_code, status_at);

-- -----------------------------------------------------------------------------
-- cdek_status_log (§3.1) — лог входящих событий webhook (порт cdek_status_log).
--   КЛЮЧ ИДЕМПОТЕНТНОСТИ (порт uk_idem): одно событие
--   (cdek_uuid + status_code + status_date_time) пишется один раз →
--   INSERT ... ON CONFLICT DO NOTHING. Для событий без status_date_time
--   WebhookService подставляет to_timestamp(0) (NULL в UNIQUE не конфликтует сам
--   с собой и не ловил бы повтор).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdek_status_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid        NOT NULL,                        -- FK → orders.id (добавляется ниже)
  cdek_uuid        text        NOT NULL,
  status_code      text        NOT NULL,
  status_name      text,
  status_date_time timestamptz,                                 -- время статуса по данным СДЭК
  city_code        integer,
  city_name        text,
  is_mock          boolean     NOT NULL DEFAULT false,          -- событие в mock-режиме
  raw_payload      jsonb,                                       -- сырое тело события (аудит/replay)
  processed        boolean     NOT NULL DEFAULT false,          -- применён ли переход статуса
  ip               text,                                        -- REMOTE_ADDR источника (webhook)
  received_at      timestamptz NOT NULL DEFAULT now()
);

-- КЛЮЧ ИДЕМПОТЕНТНОСТИ webhook (порт uk_idem из carre):
CREATE UNIQUE INDEX IF NOT EXISTS uq_cdek_status_idem
  ON cdek_status_log (cdek_uuid, status_code, status_date_time);
CREATE INDEX IF NOT EXISTS ix_cdek_status_order ON cdek_status_log (order_id);
CREATE INDEX IF NOT EXISTS ix_cdek_status_uuid  ON cdek_status_log (cdek_uuid);

-- FK на orders (CASCADE: удаление заказа чистит лог статусов).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cdek_status_log_order_fk'
  ) THEN
    ALTER TABLE cdek_status_log
      ADD CONSTRAINT cdek_status_log_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Гранты и регистрация миграции.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON cdek_shipments  TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cdek_status_log TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0017', 'cdek_shipments')
ON CONFLICT DO NOTHING;
