-- =============================================================================
-- 0046_customer_auth_tokens.sql  (Фаза 1 — шаг 7a; docs/24 §6, §10)
-- Одноразовые токены покупателя: сброс пароля и (задел) верификация email.
-- Одна таблица, назначение различается колонкой purpose.
--
-- БЕЗОПАСНОСТЬ: в БД лежит ТОЛЬКО sha256(raw) (token_hash), сырой токен уходит
-- покупателю в письме и не хранится нигде — компрометация БД не даёт восстановить
-- активные ссылки сброса. Одноразовость: used_at ставится при погашении (guarded
-- UPDATE ... WHERE used_at IS NULL). expires_at — короткий TTL. UNIQUE(token_hash)
-- защищает от коллизий и делает погашение атомарным.
--
-- FK customer_id → customers(id) ON DELETE CASCADE. Контур отдельный от admin.
--
-- Идемпотентно/аддитивно: CREATE TABLE/INDEX IF NOT EXISTS; CHECK purpose — через
-- DO-блок; GRANT идемпотентен; schema_migrations ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS customer_auth_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  purpose     text        NOT NULL,                    -- 'password_reset' | 'email_verify'
  token_hash  text        NOT NULL,                    -- sha256(raw) hex; сырой НЕ хранится
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,                             -- момент погашения (одноразовость)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- purpose ∈ {password_reset, email_verify}.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customer_auth_tokens_purpose_chk'
  ) THEN
    ALTER TABLE customer_auth_tokens
      ADD CONSTRAINT customer_auth_tokens_purpose_chk
      CHECK (purpose IN ('password_reset', 'email_verify'));
  END IF;
END $$;

-- Уникальность хеша (лукап по token_hash + атомарное погашение).
CREATE UNIQUE INDEX IF NOT EXISTS customer_auth_tokens_hash_uniq ON customer_auth_tokens (token_hash);
-- Список активных токенов покупателя по назначению (инвалидация прежних при новом запросе).
CREATE INDEX IF NOT EXISTS customer_auth_tokens_customer_idx ON customer_auth_tokens (customer_id, purpose);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_auth_tokens TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0046', 'customer_auth_tokens')
ON CONFLICT DO NOTHING;
