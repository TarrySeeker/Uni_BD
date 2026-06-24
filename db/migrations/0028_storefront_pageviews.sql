-- =============================================================================
-- 0028_storefront_pageviews.sql  (пост-роадмап — дашборд: график посещений)
-- Самостоятельный (self-hosted) счётчик посещений витрины для графика на дашборде
-- (Prevki.md «2 графика: заказы и посещения»).
--
-- ЗАЧЕМ СВОЙ СЧЁТЧИК: внешняя аналитика (GA/Метрика-облако и т.п.) исключена —
-- проект работает на самохостинге без внешних сервисов (РФ-блокировки). Поэтому
-- посещения считаем сами: витрина шлёт лёгкий beacon на публичный Storefront API
-- (POST /api/storefront/v1/events/pageview), а здесь — компактный СУТОЧНЫЙ счётчик
-- (одна строка на дату), без хранения PII и без построчного «раздувания» таблицы.
-- Уникальные посетители (distinct) — точка расширения (нужен visitor-id/куки);
-- для MVP считаем просмотры страниц (открытия), чего достаточно для графика.
--
-- Мультитенантность: без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
--
-- Идемпотентно: CREATE TABLE IF NOT EXISTS; CHECK (>= 0) через DO-блок +
-- pg_constraint (ALTER ADD CONSTRAINT не поддерживает IF NOT EXISTS); GRANT
-- идемпотентен; запись в schema_migrations — ON CONFLICT DO NOTHING. Аддитивно
-- (новая таблица; существующий код не затрагивается).
-- =============================================================================

CREATE TABLE IF NOT EXISTS storefront_pageviews (
  day    date    PRIMARY KEY,            -- сутки (UTC current_date), один счётчик на дату
  views  bigint  NOT NULL DEFAULT 0      -- число просмотров страниц витрины за сутки
);

-- CHECK (views >= 0) идемпотентно (ADD CONSTRAINT без IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'storefront_pageviews_views_nonneg'
  ) THEN
    ALTER TABLE storefront_pageviews ADD CONSTRAINT storefront_pageviews_views_nonneg
      CHECK (views >= 0);
  END IF;
END $$;

-- Рантайм приложения: INSERT/UPDATE для UPSERT-инкремента, SELECT для дашборда.
GRANT SELECT, INSERT, UPDATE ON storefront_pageviews TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0028', 'storefront_pageviews')
ON CONFLICT DO NOTHING;
