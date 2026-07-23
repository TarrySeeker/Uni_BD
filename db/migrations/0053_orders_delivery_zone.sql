-- =============================================================================
-- 0053_orders_delivery_zone.sql  (ТЗ владельца п.9 — зоны доставки)
-- Снимок выбранной зоны доставки в заказе + гарантия наличия ключа настроек.
--
-- Решения:
--   * orders.delivery_zone_id / delivery_zone_label — СНИМОК зоны из настроек
--     магазина на момент заказа (как delivery_cost). id — машинный
--     (shop_settings.delivery.zones[].id), label — подпись, которую видел
--     покупатель: владелец может переименовать зону позже, и без снимка старые
--     заказы «переехали» бы в другую зону. Обе NULL-able: у существующих заказов
--     (288 на стенде) зоны нет, и вне зонального режима они остаются NULL.
--     ANTI-TAMPER: значения пишет сервер из настроек магазина по присланному
--     zoneId, тело запроса покупателя подпись/цену зоны не несёт.
--   * МУЛЬТИТЕНАНТНОСТЬ: конкретные зоны (город и пригород и т.п.) — данные
--     КОНКРЕТНОГО магазина, а не платформы. Поэтому миграция сеет ПУСТОЙ список
--     зон (нейтральный дефолт: зональный режим выключен, витрина показывает
--     обычный курьер/ПВЗ). Реальные зоны заводит владелец в админке
--     (Настройки → Каталог и заказы) либо сид-данные конкретного инстанса.
--   * GRANT: права в 0012 выданы НА ТАБЛИЦУ orders целиком
--     (GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO admik_app), а табличная
--     привилегия в PostgreSQL распространяется на все колонки, включая
--     добавленные позже. Отдельный GRANT на новые колонки не нужен.
--
-- Идемпотентно и АДДИТИВНО (проходит scripts/check-migrations.sh):
--   ADD COLUMN IF NOT EXISTS; сид настроек — двумя шагами (см. ниже);
--   schema_migrations — ON CONFLICT DO NOTHING. НЕТ DROP/RENAME/смены типа.
-- =============================================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_id    text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_label text;

COMMENT ON COLUMN orders.delivery_zone_id    IS 'Зона доставки (снимок id из shop_settings.delivery.zones); NULL — вне зонального режима';
COMMENT ON COLUMN orders.delivery_zone_label IS 'Подпись зоны на момент заказа (снимок; переименование зоны не меняет старые заказы)';

-- -----------------------------------------------------------------------------
-- Сид ключа настроек `delivery` — ДВА шага, потому что ключ уже может быть создан
-- прошлыми настройками магазина:
--   1) ключа нет вовсе → INSERT ... ON CONFLICT DO NOTHING;
--   2) ключ есть, но БЕЗ поля zones → дописываем пустой список слиянием (||).
-- Защита `NOT (value ? 'zones')` обязательна: безусловный UPDATE затёр бы зоны,
-- которые владелец завёл формой в админке.
-- -----------------------------------------------------------------------------
INSERT INTO shop_settings (setting_key, value)
VALUES ('delivery', '{"zones":[]}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

UPDATE shop_settings
   SET value = value || '{"zones":[]}'::jsonb
 WHERE setting_key = 'delivery'
   AND NOT (value ? 'zones');

INSERT INTO schema_migrations (version, name)
VALUES ('0053', 'orders_delivery_zone')
ON CONFLICT DO NOTHING;
