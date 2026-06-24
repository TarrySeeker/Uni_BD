-- =============================================================================
-- 0016_order_number_counter.sql  (Этап 3 — модуль orders)
-- Нумератор заказов (docs/07 §2.7): человекочитаемый УНИКАЛЬНЫЙ номер заказа
--   вида `ПРЕФИКС-ГОД-NNNNNN` (напр. 'GA-2026-000123'). Таблица-счётчик с
--   атомарной выдачей `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (не
--   SEQUENCE — нужен сброс по годам и контроль формата в коде).
--
-- scope — обычно год ('2026') или 'global'; уникальность номера дополнительно
--   подстрахована orders_number_uniq (0012). last_value — bigint без identity,
--   поэтому отдельный GRANT USAGE,SELECT на sequence НЕ требуется.
--
-- Идемпотентно: CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS order_number_counters (
  scope      text   PRIMARY KEY,        -- напр. год '2026' (или 'global')
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);

-- Рантайму нужен INSERT/UPDATE для атомарной выдачи номера (без DELETE — счётчик
-- не удаляется); SELECT для чтения.
GRANT SELECT, INSERT, UPDATE ON order_number_counters TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0016', 'order_number_counter')
ON CONFLICT DO NOTHING;
