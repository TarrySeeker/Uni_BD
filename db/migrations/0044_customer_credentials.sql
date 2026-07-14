-- =============================================================================
-- 0044_customer_credentials.sql  (Фаза 1 — шаг 7a; docs/24 §6, §10)
-- ЛК покупателя (customer-auth) — АДДИТИВНО поверх customers (0013).
--
-- Аккаунт покупателя надстраивается над таблицей-якорем customers: гость (без
-- пароля) становится аккаунтом, когда у его email появляется password_hash.
-- Контур ПОЛНОСТЬЮ отдельный от admin RBAC (users/sessions) — свои колонки,
-- свои таблицы сессий/токенов (0045/0046). Пароль хранится как самодостаточная
-- PHC-строка argon2id (соль/параметры внутри строки), NULL = чистый гость.
--
-- Старые PHP-хеши carre (b_site_user.password) НЕ переносятся (ETL Фаза 3):
--   импорт как status='guest' + password_hash=NULL + принудительный reset.
--
-- Инвариант customers_account_pwd_chk (active требует пароль) объявлен NOT VALID:
--   новые/меняемые строки проверяются, но существующие гостевые строки (и будущий
--   ETL без пароля) не спотыкаются о back-fill валидацию. status='guest' от пароля
--   не зависит.
--
-- Идемпотентно/аддитивно (§6.4/ADR-015): ADD COLUMN IF NOT EXISTS; CHECK — через
-- DO-блоки (pg_constraint, т.к. ADD CONSTRAINT не поддерживает IF NOT EXISTS).
-- GRANT не нужен — колонки наследуют права таблицы customers из 0013.
-- =============================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash     text;          -- PHC argon2id; NULL = гость
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'guest';  -- существующие → 'guest'
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_login_at     timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_locale  text;          -- ∈ shop_settings.i18n.locales

-- status ∈ {guest, active, disabled}. guest — контакт-якорь без пароля;
-- active — рабочий аккаунт; disabled — заблокирован из админки.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_status_chk'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_status_chk
      CHECK (status IN ('guest', 'active', 'disabled'));
  END IF;
END $$;

-- Аккаунт (не-guest) обязан иметь пароль. NOT VALID — не валидируем back-fill
-- существующих строк (гостевой импорт без пароля), но энфорсим на write.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_account_pwd_chk'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_account_pwd_chk
      CHECK (status = 'guest' OR password_hash IS NOT NULL) NOT VALID;
  END IF;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('0044', 'customer_credentials')
ON CONFLICT DO NOTHING;
