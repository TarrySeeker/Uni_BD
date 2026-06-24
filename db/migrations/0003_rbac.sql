-- =============================================================================
-- 0003_rbac.sql
-- -----------------------------------------------------------------------------
-- Этап 1, задача 1.1/1.3 — RBAC (§2.3, ADR-005).
-- Гибкая модель «роли → права»:
--   users —< user_roles >— roles —< role_permissions >— permissions
-- Проверки в коде идут по правам (а не по именам ролей). Роли — наборы прав,
-- настраиваемые данными (seed), что обеспечивает копи-paste-универсальность.
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, GRANT — повторно безопасны.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- roles — роли (uuid + стабильный человекочитаемый code).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text         NOT NULL,               -- 'owner','admin','manager'
  title        text         NOT NULL,               -- человекочитаемое название
  is_system    boolean      NOT NULL DEFAULT false,  -- системные роли защищены от удаления
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_code_uniq ON roles (code);

-- -----------------------------------------------------------------------------
-- permissions — права. PK = семантический код вида '<домен>.<действие>'.
-- Текстовый PK стабилен между магазинами (не зависит от автоинкремента).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  code         text         PRIMARY KEY,            -- 'catalog.read','users.manage'
  title        text         NOT NULL,               -- описание для UI
  module       text                                 -- catalog/orders/cdek/cms/core
);

-- -----------------------------------------------------------------------------
-- role_permissions — связка роль ↔ право (многие-ко-многим).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         uuid  NOT NULL REFERENCES roles(id)         ON DELETE CASCADE,
  permission_code text  NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);
CREATE INDEX IF NOT EXISTS role_permissions_perm_idx ON role_permissions (permission_code);

-- -----------------------------------------------------------------------------
-- user_roles — связка пользователь ↔ роль (многие-ко-многим).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
  user_id     uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid         NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_id);

-- -----------------------------------------------------------------------------
-- GRANT для рантайма (§3.4): app выполняет полный DML на таблицах RBAC.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON roles            TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON permissions      TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles       TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0003', 'rbac')
ON CONFLICT DO NOTHING;
