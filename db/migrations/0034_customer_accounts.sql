-- =============================================================================
-- 0034_customer_accounts.sql — личный кабинет покупателя: учётные данные и сессии
-- -----------------------------------------------------------------------------
-- Достраивает задел из 0013 (`customers` без пароля) до полноценного кабинета на
-- витрине. Кабинет НЕ создаёт вторую сущность покупателя: строка `customers`
-- обычно уже существует после гостевого заказа, и регистрация лишь дописывает ей
-- учётные данные — иначе история заказов оторвалась бы от аккаунта.
--
-- КОНТУР ОТДЕЛЬНЫЙ ОТ АДМИНКИ. У покупателя своя таблица сессий, своя cookie и
-- НИКАКИХ ролей: он не должен иметь ни малейшего отношения к RBAC сотрудников.
-- Разделение делает класс ошибки «клиент получил права админа» невозможным, а не
-- маловероятным.
--
-- Мультитенантно: таблицы существуют всегда, магазин без кабинета просто не
-- создаёт паролей и сессий (как `customers` у магазина без аккаунтов). Модуль
-- `account` в `ADMIK_MODULES` управляет тем, отвечают ли роуты кабинета.
--
-- Идемпотентно: ADD COLUMN / CREATE TABLE / CREATE INDEX — все IF NOT EXISTS;
-- CHECK-ограничения через DO-блок (для ADD CONSTRAINT нет IF NOT EXISTS).
-- Гранты на `customers` выданы в 0013 и наследуются новыми колонками.
-- =============================================================================

-- --- Учётные данные покупателя ----------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash     text;         -- PHC argon2id; NULL = гость
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'guest';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;  -- NULL = адрес не подтверждён
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_login_at     timestamptz;

COMMENT ON COLUMN customers.status IS
  'guest — контакт от гостевого заказа без пароля; active — рабочий аккаунт; disabled — заблокирован из админки';
COMMENT ON COLUMN customers.email_verified_at IS
  'Момент подтверждения владения адресом. До него гостевые заказы по совпадению email НЕ показываются: регистрация на чужой адрес иначе отдавала бы чужие заказы';

-- status ∈ {guest, active, disabled}.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_status_chk') THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_status_chk
      CHECK (status IN ('guest', 'active', 'disabled'));
  END IF;
END $$;

-- Аккаунт (не гость) обязан иметь пароль. NOT VALID: существующие гостевые
-- строки не перепроверяем (у них пароля нет и не должно быть), но на запись
-- инвариант действует.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_account_pwd_chk') THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_account_pwd_chk
      CHECK (status = 'guest' OR password_hash IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- --- Серверные сессии покупателя --------------------------------------------
-- Сессия хранится в БД, а не в подписанном токене: выход и «выйти на всех
-- устройствах» обязаны срабатывать немедленно, а отозвать выданный JWT нельзя.
--
-- В `id` лежит sha256 ОТ ТОКЕНА, а не сам токен. Сырой токен уходит клиенту и в
-- базе не хранится: иначе дамп базы, лог запроса или доступ «только на чтение»
-- давали бы готовый набор действующих сессий. Хеша здесь достаточно (в отличие
-- от паролей): токен высокоэнтропийный и короткоживущий, перебирать его
-- бессмысленно, а замедлять проверку на каждом запросе — вредно.
CREATE TABLE IF NOT EXISTS customer_sessions (
  id          text        PRIMARY KEY,                 -- sha256(hex) от сырого токена
  customer_id uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  -- inet, а не text: тип согласован с sessions админки, и Postgres сам отвергает
  -- мусор. ⚠️ значение обязано пройти нормализацию (lib/server/request-ip.ts) —
  -- сырой заголовок роняет INSERT на касте, а вместе с ним и вход.
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN customer_sessions.id IS
  'sha256 от сырого токена сессии. Сырой токен есть только у клиента — дамп БД не даёт угнать сессии';

CREATE INDEX IF NOT EXISTS customer_sessions_customer_idx ON customer_sessions (customer_id);
-- Под фоновую чистку просроченных: без неё строки покупателей, которые не
-- вернулись, копятся вечно (ленивое удаление срабатывает только при обращении).
CREATE INDEX IF NOT EXISTS customer_sessions_expires_idx  ON customer_sessions (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_sessions TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0034', 'customer_accounts')
ON CONFLICT DO NOTHING;
