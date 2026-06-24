-- =============================================================================
-- 0001_init_extensions_and_migrations.sql
-- -----------------------------------------------------------------------------
-- Этап 1, задача 1.1 — базовый слой БД.
--   * Расширения pgcrypto (gen_random_uuid) и citext (регистронезависимый email).
--   * Служебная таблица schema_migrations — журнал применённых миграций.
--   * Две роли БД (ADR-002/ADR-006): admik_migrator (DDL) и admik_app (DML рантайма).
--   * Базовые GRANT на схему public.
--
-- Идемпотентность (ADR-002, §3.2): все конструкции безопасны при повторном накате.
--   CREATE ROLE не поддерживает IF NOT EXISTS → создаём через DO-блоки с проверкой
--   pg_roles. Пароли ролей приходят psql-переменными :'APP_PASSWORD'/:'MIGRATOR_PASSWORD'
--   (init-shop.sh передаёт их через psql -v ...); в репозитории паролей нет.
-- =============================================================================

-- Расширения. IF NOT EXISTS делает накат идемпотентным.
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), crypt()
CREATE EXTENSION IF NOT EXISTS citext;       -- регистронезависимый email

-- -----------------------------------------------------------------------------
-- Журнал применённых миграций. Не подменяет идемпотентность DDL, а даёт историю
-- эволюции схемы. Каждая миграция в своём конце пишет сюда строку.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text         PRIMARY KEY,         -- '0001', '0002', ...
  name        text         NOT NULL,            -- имя файла без расширения
  applied_at  timestamptz  NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Роли БД (§3.4). CREATE ROLE не поддерживает IF NOT EXISTS → идемпотентность
-- обеспечиваем DO-блоками с проверкой существования роли в pg_roles.
--   * admik_migrator — владеет схемой, может менять DDL (под ним идут миграции).
--   * admik_app      — рантайм приложения, только минимальный DML.
-- Пароли — из psql-переменных (init-shop.sh передаёт -v APP_PASSWORD=... и т.п.).
-- -----------------------------------------------------------------------------
-- ВАЖНО: psql НЕ подставляет :переменные внутри dollar-quoted ($$...$$) блоков,
-- поэтому роли с паролями создаём через `SELECT ... \gexec`: подстановка :'..'
-- работает в обычном SELECT, %L безопасно квотирует пароль, WHERE NOT EXISTS даёт
-- идемпотентность (роль уже есть → 0 строк → \gexec ничего не выполняет).
-- (Ранее тут был DO $$..$$ с :'MIGRATOR_PASSWORD' — он не подставлялся и ломал
-- накат на свежей БД ошибкой «syntax error at or near :».)
SELECT format('CREATE ROLE admik_migrator LOGIN PASSWORD %L', :'MIGRATOR_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admik_migrator')
\gexec

SELECT format('CREATE ROLE admik_app LOGIN PASSWORD %L', :'APP_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admik_app')
\gexec

-- -----------------------------------------------------------------------------
-- Базовые GRANT на схему (§3.4).
--   * migrator получает полный доступ к схеме (владение DDL).
--   * app — только USAGE на схему; точечные DML-права на таблицы выдаются в конце
--     соответствующих миграций (0002/0003/0004), ничего лишнего заранее.
-- GRANT идемпотентен по своей природе (повторная выдача того же права — no-op).
-- -----------------------------------------------------------------------------
GRANT ALL   ON SCHEMA public TO admik_migrator;
GRANT USAGE ON SCHEMA public TO admik_app;

-- app должен уметь читать журнал миграций (диагностика), но не менять его.
GRANT SELECT ON schema_migrations TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0001', 'init_extensions_and_migrations')
ON CONFLICT DO NOTHING;
