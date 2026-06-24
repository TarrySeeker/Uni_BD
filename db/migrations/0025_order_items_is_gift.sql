-- =============================================================================
-- 0025_order_items_is_gift.sql  (пост-роадмап — модуль orders, бэклог «gift-позиция»)
-- Аддитивно к 0012_orders: флаг подарочной позиции заказа.
--   * order_items.is_gift — true для строки-подарка (товар по промокоду gift_*,
--     unit_price = 0). Обычные позиции — false (DEFAULT).
--
-- Зачем: ADR-014 заложил поля promo_codes.gift_* (товар-подарок), но фактическая
--   ВЫДАЧА подарка отдельной строкой заказа была отложена. Эта миграция + код
--   createOrder/quoteCart реализуют выдачу. Флаг отличает подарок от обычной
--   позиции (для админки/витрины/возвратов), не полагаясь на unit_price = 0.
--
-- Без backfill: DEFAULT false покрывает существующие строки. Идемпотентно
--   (ADD COLUMN IF NOT EXISTS). Совместимо: старый код игнорирует новую колонку.
-- =============================================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_gift boolean NOT NULL DEFAULT false;

-- Частичный индекс для выборки подарочных позиций (аналитика/отчёты); подарки
-- редки, поэтому индексируем только их.
CREATE INDEX IF NOT EXISTS order_items_gift_idx ON order_items (order_id) WHERE is_gift;

INSERT INTO schema_migrations (version, name)
VALUES ('0025', 'order_items_is_gift')
ON CONFLICT DO NOTHING;
