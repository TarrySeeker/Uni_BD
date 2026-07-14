-- =============================================================================
-- 0036_i18n_settings_seed.sql  (Фаза 1b — фундамент i18n; ADR-i18n, docs/24 §1)
-- Сид конфигурации языков магазина в shop_settings. defaultLocale + список
-- включённых locales — per-shop, БЕЗ хардкода в коде: lib/i18n читает эту строку
-- (getLocaleConfig), env-дефолт [ru, en, fr] применяется только при отсутствии.
--
-- Без структурных изменений схемы: shop_settings — key/value jsonb (0019). ключ
-- раздела в carre-схеме называется `setting_key` (не `key`, как в DDL-эскизе
-- docs/24 §1 — здесь верное имя реальной колонки).
--
-- Идемпотентно: INSERT ... ON CONFLICT (setting_key) DO NOTHING — повторный накат
-- НЕ перетирает ручные правки владельца (список языков он может менять в админке).
-- schema_migrations ON CONFLICT DO NOTHING.
-- =============================================================================

INSERT INTO shop_settings (setting_key, value)
VALUES ('i18n', '{"defaultLocale":"ru","locales":["ru","en","fr"]}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES ('0036', 'i18n_settings_seed')
ON CONFLICT DO NOTHING;
