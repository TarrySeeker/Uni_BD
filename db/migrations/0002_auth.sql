-- =============================================================================
-- 0002_auth.sql
-- -----------------------------------------------------------------------------
-- Этап 1, задача 1.1/1.2 — аутентификация (Lucia-подход, §2.1, §2.2).
--   * users    — учётные записи (argon2id-хеш пароля, флаг владельца, статус).
--   * sessions — серверные сессии в БД (id из cookie, истечение, диагностика).
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, GRANT — повторно безопасны.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users (§2.1)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext       NOT NULL,
  password_hash   text         NOT NULL,            -- PHC-строка argon2id ($argon2id$...)
  display_name    text         NOT NULL DEFAULT '',
  status          text         NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled', 'invited')),
  is_owner        boolean      NOT NULL DEFAULT false,  -- супер-владелец (RBAC §5.4)
  last_login_at   timestamptz,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- Email уникален без учёта регистра (citext уже регистронезависим).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq ON users (email);
CREATE INDEX        IF NOT EXISTS users_status_idx ON users (status);

-- -----------------------------------------------------------------------------
-- sessions (§2.2) — Lucia-подход
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           text         PRIMARY KEY,            -- криптослучайный id (как есть)
  user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz  NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  ip           inet,                                -- IP создания сессии (диагностика)
  user_agent   text                                 -- UA (диагностика/безопасность)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- -----------------------------------------------------------------------------
-- GRANT для рантайма (§3.4): app выполняет полный DML на учётках и сессиях.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON users    TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0002', 'auth')
ON CONFLICT DO NOTHING;
