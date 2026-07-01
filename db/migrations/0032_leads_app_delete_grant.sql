-- =============================================================================
-- 0032_leads_app_delete_grant.sql  (пост-роадмап — G-09: обработка заявок)
-- Аддитивно: выдаёт рантайму приложения право DELETE на leads. Раздел /admin/leads
-- был «тупиком владельца» (аудит, dead-button): заявки висели в статусе 'new'
-- навсегда. Теперь владелец меняет статус (UPDATE — уже был в 0030) и удаляет
-- обработанные заявки (deleteLead, Server Action под правом orders.write).
--
-- 0030 выдал admik_app только SELECT/INSERT/UPDATE — для hard-delete нужен DELETE.
-- Мультитенантность: без tenant_id/website_id (ADR-003: 1 магазин = 1 БД).
-- Идемпотентно: GRANT идемпотентен (повторный накат безвреден); накатывается на
-- любую БД, где таблица leads уже создана миграцией 0030; schema_migrations —
-- ON CONFLICT DO NOTHING.
-- =============================================================================

GRANT DELETE ON leads TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0032', 'leads_app_delete_grant')
ON CONFLICT DO NOTHING;
