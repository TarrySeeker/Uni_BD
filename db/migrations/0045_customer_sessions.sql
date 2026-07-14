-- =============================================================================
-- 0045_customer_sessions.sql  (Фаза 1 — шаг 7a; docs/24 §6, §10)
-- Сессии покупателя — ОТДЕЛЬНАЯ таблица (образец admin sessions 0002), НЕ
-- переиспользуем admin `sessions`. Токен сессии = высокоэнтропийный base32
-- (160 бит), он же PK; хранится как есть (как admin sessions.id), передаётся
-- клиенту через httpOnly-cookie `admik_customer_session` ИЛИ `Authorization:
-- Bearer` (см. lib/customer-auth/cookies.ts). expires_at — скользящее окно.
--
-- FK customer_id → customers(id) ON DELETE CASCADE: удаление покупателя уносит
-- его сессии. Контур отдельный от admin — ни users, ни ролей, ни прав.
--
-- Идемпотентно/аддитивно: CREATE TABLE/INDEX IF NOT EXISTS; GRANT идемпотентен;
-- schema_migrations ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS customer_sessions (
  id          text        PRIMARY KEY,                 -- криптослучайный base32, 160 бит (сам токен)
  customer_id uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  user_agent  text
);

CREATE INDEX IF NOT EXISTS customer_sessions_customer_idx ON customer_sessions (customer_id);
CREATE INDEX IF NOT EXISTS customer_sessions_expires_idx  ON customer_sessions (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_sessions TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0045', 'customer_sessions')
ON CONFLICT DO NOTHING;
