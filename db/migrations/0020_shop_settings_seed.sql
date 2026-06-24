-- =============================================================================
-- 0020_shop_settings_seed.sql  (Этап 5 — подсистема 5.4, пакет 5.D-1)
-- Идемпотентный seed ключей настроек (docs/11 §5.4.2).
--
-- Сидируем основные разделы ПУСТЫМИ объектами '{}'::jsonb. Пустой объект =
-- «нет оверрайда» → при чтении (mergeSettings) раздел падает на env-дефолт.
-- Это даёт администратору готовые строки для правки через UI без ручного
-- INSERT, не навязывая магазино-специфичных значений.
--
-- ON CONFLICT (setting_key) DO NOTHING (НЕ DO UPDATE): повторный накат миграций
-- НЕ затирает уже отредактированные администратором значения.
-- =============================================================================

INSERT INTO shop_settings (setting_key, value)
VALUES
  ('branding',         '{}'::jsonb),
  ('currency',         '{}'::jsonb),
  ('units',            '{}'::jsonb),
  ('module_overrides', '{}'::jsonb),
  ('seo',              '{}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES ('0020', 'shop_settings_seed')
ON CONFLICT DO NOTHING;
