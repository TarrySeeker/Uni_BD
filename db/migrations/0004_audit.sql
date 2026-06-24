-- =============================================================================
-- 0004_audit.sql
-- -----------------------------------------------------------------------------
-- Этап 1, задача 1.1/1.5 — сквозной аудит (§2.4).
--   audit_log: кто / что / когда / над какой сущностью / до→после (JSONB) / IP.
--
-- Append-only на уровне прав БД (§3.4, ADR-006): роль admik_app получает только
-- SELECT и INSERT на audit_log — БЕЗ UPDATE/DELETE. Так компрометация рантайма
-- не позволяет переписать или стереть журнал.
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, GRANT — повторно безопасны.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- audit_log (§2.4). id — монотонный bigint (GENERATED ALWAYS AS IDENTITY) для
-- стабильной пагинации/сортировки. actor_user_id → SET NULL: запись переживает
-- удаление пользователя; actor_email денормализован, чтобы журнал оставался
-- читаемым после удаления учётки.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid         REFERENCES users(id) ON DELETE SET NULL,  -- кто (NULL = система)
  actor_email   citext,                            -- email на момент действия (денормализ.)
  action        text         NOT NULL,             -- 'auth.login','user.update', ...
  entity_type   text,                              -- 'user','role','order', ...
  entity_id     text,                              -- id затронутой сущности (text — универсально)
  before_data   jsonb,                             -- состояние ДО (NULL для create)
  after_data    jsonb,                             -- состояние ПОСЛЕ (NULL для delete)
  ip            inet,                              -- IP инициатора
  user_agent    text,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx      ON audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx     ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx     ON audit_log (action);

-- -----------------------------------------------------------------------------
-- GRANT для рантайма (§3.4): audit_log append-only — ТОЛЬКО SELECT, INSERT.
-- Никаких UPDATE/DELETE для admik_app → журнал неизменяем на уровне прав СУБД.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON audit_log TO admik_app;

-- Доступ к sequence/identity для INSERT с автогенерацией id во всех таблицах схемы.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0004', 'audit')
ON CONFLICT DO NOTHING;
