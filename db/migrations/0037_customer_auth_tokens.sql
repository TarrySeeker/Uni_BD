-- =============================================================================
-- 0037_customer_auth_tokens.sql — одноразовые токены покупателя
-- -----------------------------------------------------------------------------
-- Одна таблица на два сценария: подтверждение адреса почты и восстановление
-- пароля. Механика у них идентична (выдали ссылку → перешли → погасили), поэтому
-- две таблицы означали бы два набора одинаковых ошибок.
--
-- ХРАНИМ ТОЛЬКО ХЕШ. Сырой токен уходит в письмо и в базе не появляется: иначе
-- дамп базы, лог запроса или доступ «только на чтение» позволяли бы подтвердить
-- чужой адрес и сбросить чужой пароль. sha256 здесь достаточно (в отличие от
-- паролей): токен высокоэнтропийный и живёт часы, перебирать его бессмысленно.
--
-- ОДНОРАЗОВОСТЬ ГАСИТСЯ В БАЗЕ, А НЕ В КОДЕ. `used_at` + уникальный индекс по
-- хешу дают атомарное погашение: `UPDATE ... WHERE used_at IS NULL` выигрывает
-- ровно один запрос. Вариант «прочитали токен → выполнили действие → удалили»
-- оставляет окно, в которое проходит второй.
--
-- ⚠️ Восстановление пароля — не «потом добавим». Без него забытый пароль означает
-- безвозвратно потерянный аккаунт, а поддержке приходится сбрасывать пароли
-- вручную на каждого клиента.
--
-- Идемпотентно: CREATE TABLE / CREATE INDEX — IF NOT EXISTS; CHECK — через
-- DO-блок (для ADD CONSTRAINT нет IF NOT EXISTS).
-- =============================================================================

CREATE TABLE IF NOT EXISTS customer_auth_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  purpose     text        NOT NULL,                    -- 'password_reset' | 'email_verify'
  token_hash  text        NOT NULL,                    -- sha256(hex) от сырого токена
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,                             -- момент погашения; NULL = ещё действует
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN customer_auth_tokens.token_hash IS
  'sha256 от сырого токена. Сырой уходит только в письмо — дамп БД не даёт подтвердить чужой адрес или сбросить чужой пароль';
COMMENT ON COLUMN customer_auth_tokens.used_at IS
  'Одноразовость: гасится через UPDATE ... WHERE used_at IS NULL — атомарно, без гонки';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_auth_tokens_purpose_chk') THEN
    ALTER TABLE customer_auth_tokens
      ADD CONSTRAINT customer_auth_tokens_purpose_chk
      CHECK (purpose IN ('password_reset', 'email_verify'));
  END IF;
END $$;

-- Уникальность хеша — половина механизма одноразовости (вторая половина `used_at`).
CREATE UNIQUE INDEX IF NOT EXISTS customer_auth_tokens_hash_uniq
  ON customer_auth_tokens (token_hash);

-- Выдача нового токена гасит прежние того же назначения — обход по этому индексу.
CREATE INDEX IF NOT EXISTS customer_auth_tokens_customer_idx
  ON customer_auth_tokens (customer_id, purpose);

-- Под фоновую чистку просроченных.
CREATE INDEX IF NOT EXISTS customer_auth_tokens_expires_idx
  ON customer_auth_tokens (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_auth_tokens TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0037', 'customer_auth_tokens')
ON CONFLICT DO NOTHING;
