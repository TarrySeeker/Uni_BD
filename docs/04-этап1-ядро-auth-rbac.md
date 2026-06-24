# Этап 1 — Ядро + Auth + RBAC + каркас админки + audit_log

> **Автор:** Solution Architect. **Статус:** проектный документ (design), не финальный код приложения.
> **Дата:** 2026-06-15.
> **Связанные документы:** `CLAUDE.md`, `docs/00-журнал-проекта.md`, `docs/01-архитектурные-решения.md`
> (ADR-001…006), `docs/02-модель-развёртывания.md`, `docs/03-роадмап.md` (раздел «Этап 1»).
> **Назначение.** Полная проектная спецификация Этапа 1: цель, схема БД (DDL-эскизы),
> стратегия миграций, аутентификация, RBAC, каркас админки, аудит, декомпозиция на задачи
> с принципом «сначала тесты» (ADR-004) и список новых зависимостей.
>
> Все DDL/сигнатуры ниже — **проектные эскизы**. Их реализуют агенты Backend/Frontend Team
> на следующем шаге; здесь зафиксированы контракты, типы, индексы и порядок работ.

---

## 1. Цель и охват этапа

### 1.1. Цель

Дать платформе Admik фундамент прикладной логики, поверх которого строятся все модули 2–5:

1. **Слой доступа к БД** (`postgres.js`, tagged templates) и **движок идемпотентных миграций**
   с двумя ролями БД (`app` / `migrator`, ADR-002).
2. **Аутентификация** по Lucia-подходу: пользователи, сессии в БД, безопасное хеширование
   паролей, защита от timing-атак, rate-limit на логин (Redis), httpOnly-cookie.
3. **RBAC** — гибкая модель «роли → права» (а не enum-роли, см. ADR-005), серверные гварды
   для Server Actions и роутов, роль супер-владельца.
4. **Каркас админки** `/admin/*` (App Router): layout с навигацией, состав меню — функция от
   включённых модулей (`lib/config/modules.ts`) и прав пользователя; страница логина; дашборд-заглушка.
5. **Сквозной аудит** (`audit_log`): кто/что/когда/над какой сущностью/до→после (JSONB)/IP,
   единый helper записи, встроенный в унифицированный паттерн Server Action.
6. **Унифицированный паттерн Server Action** (ADR-002): `guard → Zod → БД → инвалидация → audit`.

### 1.2. В охвате (in scope)

- Таблицы: `users`, `sessions`, `roles`, `permissions`, `role_permissions`, `user_roles`,
  `audit_log`, служебная `schema_migrations` (журнал применённых миграций).
- Server Actions: `login`, `logout`, `changePassword`; серверные функции проверки прав.
- Seed: создание роли супер-владельца, набора базовых прав, создание **владельца магазина**
  при инициализации (закрывает «заглушку seed» в `scripts/init-shop.sh`, шаг 4).
- Страницы: `/admin/login`, `/admin` (дашборд-заглушка), `/admin/audit` (просмотр журнала),
  каркас `/admin/users` и `/admin/roles` (управление доступом — минимальный CRUD).

### 1.3. Вне охвата (out of scope, переносится в следующие этапы)

- Бизнес-модули (каталог/заказы/СДЭК/CMS) — Этапы 2–5.
- UI-раздел «Настройки магазина» (брендинг через UI) — Этап 5.4 (на Этапе 1 брендинг
  читается из `.env`: `SHOP_NAME`, `SHOP_LOGO_URL`).
- Сброс пароля по email, 2FA — отложено (заложить точки расширения, не реализовывать).

### 1.4. Критерии завершения этапа (Definition of Done)

- [ ] Миграции `db/migrations/0001…0004_*.sql` накатываются `scripts/init-shop.sh` на пустую БД
      **одной командой** и **повторный накат безопасен** (идемпотентность подтверждена тестом).
- [ ] Существуют две роли БД (`app`, `migrator`); приложение в рантайме ходит под `app`
      с минимально необходимыми правами (ADR-002, ADR-006).
- [ ] Логин/логаут работают; неверные креды отклоняются с защитой от timing-атак;
      сессия хранится в БД, кука `httpOnly`/`Secure`/`SameSite=Lax`; rate-limit на логин включён.
- [ ] Любое действие без нужного права **блокируется на сервере** (не только скрыто в UI).
- [ ] Каркас `/admin` рендерит навигацию; пункты меню скрываются по выключенным модулям и по
      правам; проходит a11y-проверки Playwright.
- [ ] Значимые действия пишутся в `audit_log` (кто/что/когда/до→после/IP); журнал виден в `/admin/audit`.
- [ ] Seed создаёт владельца магазина из `.env` (а не хардкодом); пароль владельца не лежит в репозитории.
- [ ] Покрытие тестами по ADR-004: для каждой задачи тесты написаны **раньше** реализации и зелёные.
- [ ] Нет хардкодов магазина; копи-paste-развёртывание не нарушено (`docs/02`).

---

## 2. Схема БД (DDL-эскизы PostgreSQL)

**Общие правила (ADR-002):**
- Все таблицы — идемпотентно: `CREATE TABLE IF NOT EXISTS`.
- Деньги — `NUMERIC(14,2)` (на Этапе 1 денег нет, но правило фиксируется для модулей далее).
- Время — всегда `TIMESTAMPTZ`, значения в UTC (`now()` под `SET TIME ZONE 'UTC'`).
- Первичные ключи: для бизнес-сущностей — `uuid` (`gen_random_uuid()` из расширения `pgcrypto`),
  чтобы id не были перечислимыми и переносились между магазинами без коллизий автоинкремента.
  Для справочников прав/ролей допустим `text`-код (стабильные семантические ключи).
- Связи — с явными `FOREIGN KEY` и осознанным `ON DELETE` (см. ниже).

### 2.0. Расширения и служебная таблица миграций

```sql
-- 0001_init_extensions_and_migrations.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), crypt() при необходимости
CREATE EXTENSION IF NOT EXISTS citext;       -- регистронезависимый email

-- Журнал применённых миграций (даже при идемпотентности полезно знать историю).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text         PRIMARY KEY,         -- '0001', '0002', ...
  name        text         NOT NULL,            -- имя файла без расширения
  applied_at  timestamptz  NOT NULL DEFAULT now()
);
```

> Запись в `schema_migrations` каждая миграция делает в своём конце:
> `INSERT INTO schema_migrations(version,name) VALUES ('0001','init_...') ON CONFLICT DO NOTHING;`
> Это не подменяет идемпотентность DDL, а даёт аудит истории схемы.

### 2.1. `users`

```sql
-- 0002_auth.sql (часть 1)
CREATE TABLE IF NOT EXISTS users (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext       NOT NULL,
  password_hash   text         NOT NULL,           -- argon2id (PHC-строка $argon2id$...)
  display_name    text         NOT NULL DEFAULT '',
  status          text         NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','disabled','invited')),
  is_owner        boolean      NOT NULL DEFAULT false,  -- супер-владелец (см. RBAC §5.4)
  last_login_at   timestamptz,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- Email уникален без учёта регистра (тип citext уже регистронезависим).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq ON users (email);
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
```

- `password_hash` — PHC-строка argon2id (соль и параметры внутри строки; отдельная колонка соли
  не нужна). Выбор алгоритма — ADR-006.
- `is_owner = true` — особый флаг: владелец проходит все проверки прав (§5.4). Создаётся seed-ом.
- `status` управляет доступом: `disabled` → логин запрещён, активные сессии инвалидируются.

### 2.2. `sessions` (Lucia-подход)

```sql
-- 0002_auth.sql (часть 2)
CREATE TABLE IF NOT EXISTS sessions (
  id           text         PRIMARY KEY,        -- криптослучайный id (хранится как есть)
  user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz  NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  ip           inet,                            -- IP, с которого создана сессия (диагностика)
  user_agent   text                             -- UA (диагностика/безопасность)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx   ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
```

- Lucia-подход: `id` сессии генерируется криптостойко (≥ 120 бит энтропии), кладётся в httpOnly-cookie,
  по нему ищется строка. `ON DELETE CASCADE` — удаление пользователя гасит его сессии.
- Просроченные сессии удаляются ленивым GC при валидации + периодическим `DELETE WHERE expires_at < now()`.
- **Ротация при привилегированных действиях** (смена пароля) — старые сессии пользователя удаляются.

### 2.3. RBAC: `roles`, `permissions`, `role_permissions`, `user_roles`

Обоснование выбора модели — **§5.1 и ADR-005** (гибкая модель ролей+прав, а не enum-роли).

```sql
-- 0003_rbac.sql
CREATE TABLE IF NOT EXISTS roles (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text         NOT NULL,            -- стабильный код: 'owner','admin','manager'
  title        text         NOT NULL,            -- человекочитаемое название
  is_system    boolean      NOT NULL DEFAULT false, -- системные роли нельзя удалять/переименовывать code
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_code_uniq ON roles (code);

CREATE TABLE IF NOT EXISTS permissions (
  code         text         PRIMARY KEY,         -- 'catalog.read','orders.write','users.manage'
  title        text         NOT NULL,            -- описание для UI
  module       text                              -- к какому модулю относится (catalog/orders/cdek/cms/core)
);

-- Связка роль↔право (многие-ко-многим).
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         uuid  NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
  permission_code text  NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);
CREATE INDEX IF NOT EXISTS role_permissions_perm_idx ON role_permissions (permission_code);

-- Связка пользователь↔роль (многие-ко-многим: у пользователя может быть несколько ролей).
CREATE TABLE IF NOT EXISTS user_roles (
  user_id     uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_id);
```

**Почему именно так:**
- `permissions.code` — текстовый PK (семантический ключ вида `domain.action`). Стабилен между
  магазинами; права сидируются кодом, не зависят от автоинкремента → перенос/копи-paste безопасен.
- `roles` имеют `uuid` + уникальный `code`. `is_system` защищает базовые роли от удаления.
- Многие-ко-многим во **обоих** связках: пользователь может иметь несколько ролей; право может
  входить в несколько ролей. Эффективные права пользователя = объединение прав всех его ролей
  (+ безусловный «всё» для `is_owner`).
- Каскады: удаление роли/пользователя чистит связки; удаление `permission` (редкое, при рефакторинге
  модулей) чистит привязки к ролям.

### 2.4. `audit_log`

```sql
-- 0004_audit.sql
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- монотонный, для пагинации/сортировки
  actor_user_id uuid         REFERENCES users(id) ON DELETE SET NULL, -- кто (NULL = система/анонимно)
  actor_email   citext,                          -- денормализованный email на момент действия (живёт, даже если юзера удалят)
  action        text         NOT NULL,           -- 'auth.login','user.update','role.grant', ...
  entity_type   text,                            -- 'user','role','order', ...
  entity_id     text,                            -- id затронутой сущности (text — универсально для uuid/bigint)
  before_data   jsonb,                           -- состояние ДО (NULL для create)
  after_data    jsonb,                           -- состояние ПОСЛЕ (NULL для delete)
  ip            inet,                            -- IP инициатора
  user_agent    text,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx      ON audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx     ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx     ON audit_log (action);
```

- **Неизменяемость:** роль `app` получает только `INSERT`/`SELECT` на `audit_log` (без UPDATE/DELETE),
  см. §3.4 и ADR-006. Это делает журнал практически append-only на уровне прав БД.
- `actor_email` денормализуется намеренно: запись аудита должна оставаться читаемой даже после
  удаления пользователя (поэтому FK с `ON DELETE SET NULL`, а email сохраняется отдельно).
- `before_data`/`after_data` (JSONB) хранят снимок изменённых полей. Чувствительные поля
  (`password_hash`) **никогда не пишутся** в аудит (редактируются хелпером, §7).
- `entity_id` — `text`, чтобы единообразно логировать сущности с разными типами ключей.

### 2.5. Сводка FK и стратегий удаления

| Таблица | FK | ON DELETE | Причина |
|---|---|---|---|
| `sessions.user_id` | → `users.id` | CASCADE | удаление юзера гасит его сессии |
| `role_permissions.role_id` | → `roles.id` | CASCADE | чистим связки удалённой роли |
| `role_permissions.permission_code` | → `permissions.code` | CASCADE | чистим связки удалённого права |
| `user_roles.user_id` | → `users.id` | CASCADE | чистим роли удалённого юзера |
| `user_roles.role_id` | → `roles.id` | CASCADE | чистим назначения удалённой роли |
| `audit_log.actor_user_id` | → `users.id` | SET NULL | сохраняем историю после удаления юзера |

---

## 3. Стратегия миграций

### 3.1. Формат файлов и нумерация

- Каталог: `db/migrations/`.
- Имя файла: **`NNNN_краткое-имя.sql`**, где `NNNN` — 4-значный порядковый номер с ведущими нулями
  (`0001`, `0002`, …). Порядок наката = лексикографическая сортировка имён, что **совместимо с уже
  существующим `scripts/init-shop.sh`** (он берёт `db/migrations/*.sql`, сортирует `sort`, применяет
  `psql -v ON_ERROR_STOP=1 -f`).
- Кодировка UTF-8, идемпотентность обязательна: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
  `... ON CONFLICT DO NOTHING`, и безопасные `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

**Состав миграций Этапа 1:**

| Файл | Содержимое |
|---|---|
| `0001_init_extensions_and_migrations.sql` | расширения (`pgcrypto`, `citext`), `schema_migrations`, роли БД и базовые GRANT (§3.4) |
| `0002_auth.sql` | `users`, `sessions` + индексы |
| `0003_rbac.sql` | `roles`, `permissions`, `role_permissions`, `user_roles` + индексы |
| `0004_audit.sql` | `audit_log` + индексы + ограничение прав `app` на append-only |

> Seed (роли/права/владелец) — **не миграция**, а отдельный шаг (§4.2), чтобы данные магазина не
> смешивались со схемой. Идемпотентность seed обеспечивается `ON CONFLICT DO NOTHING` и проверкой
> существования владельца.

### 3.2. Идемпотентность: правила для авторов миграций

1. Только идемпотентные конструкции (перечислены выше). Никаких «голых» `CREATE TABLE` без `IF NOT EXISTS`.
2. Изменение существующих таблиц в будущих этапах — `ADD COLUMN IF NOT EXISTS`, новые индексы —
   `CREATE INDEX IF NOT EXISTS`. **Не** переименовывать/удалять колонки с данными без явной
   обратной совместимости (`docs/02`, чек-лист «обновление не ломает данные»).
3. Каждая миграция завершается записью в `schema_migrations` через `INSERT ... ON CONFLICT DO NOTHING`.
4. Повторный полный накат на уже инициализированную БД не меняет данные и не падает.

### 3.3. Порядок наката (совместимость с `init-shop.sh`)

`scripts/init-shop.sh` уже реализует шаг 3 (накат `db/migrations/*.sql` по порядку под
`POSTGRES_USER`). Этап 1 встраивается так:

1. **Миграции** (`0001…0004`) применяются как есть существующим скриптом — править скрипт не нужно,
   достаточно положить файлы.
2. **Seed** (§4.2) подключается на шаге 4 скрипта (сейчас там заглушка «Seed пока не реализован»):
   добавить вызов `db/seed/*.sql` и/или `node db/seed/owner.mjs`, читающий `.env`
   (`OWNER_EMAIL`, `OWNER_PASSWORD` / временный пароль). Изменение скрипта — задача DevOps-агента
   в рамках задачи 1.7, по согласованию с этим документом.

> Замечание по ролям БД: `init-shop.sh` подключается под `POSTGRES_USER` (владелец БД). Миграции
> создают роли `app`/`migrator` и выдают гранты; приложение в рантайме использует **отдельный
> `DATABASE_URL` под ролью `app`**. См. §3.4 и ADR-006.

### 3.4. Две роли БД (`app` / `migrator`) — ADR-002 / ADR-006

```sql
-- фрагмент 0001 (идемпотентно через DO-блоки, т.к. CREATE ROLE не поддерживает IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admik_migrator') THEN
    CREATE ROLE admik_migrator LOGIN PASSWORD :'MIGRATOR_PASSWORD';  -- пароль из переменной psql
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admik_app') THEN
    CREATE ROLE admik_app LOGIN PASSWORD :'APP_PASSWORD';
  END IF;
END $$;

-- migrator владеет схемой и может менять DDL.
GRANT ALL    ON SCHEMA public TO admik_migrator;
-- app — только DML на прикладных таблицах, и НИЧЕГО лишнего.
GRANT USAGE  ON SCHEMA public TO admik_app;

-- После создания таблиц (в конце 0002/0003/0004) выдаём app точечные права, например:
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, roles, permissions,
      role_permissions, user_roles TO admik_app;
-- audit_log — append-only для app: только INSERT/SELECT (без UPDATE/DELETE).
GRANT SELECT, INSERT ON audit_log TO admik_app;
-- доступ к sequence/identity для INSERT с автогенерацией:
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO admik_app;
```

- **Разделение:** миграции запускаются под `migrator` (или владельцем БД, как сейчас в скрипте);
  приложение в рантайме ходит **только под `app`**. Так компрометация рантайма не даёт менять схему
  и не даёт переписывать/удалять аудит.
- Пароли ролей берутся из `.env` (`MIGRATOR_PASSWORD`, `APP_PASSWORD`) и передаются в `psql` через
  `-v`. В репозитории — только `.env.example`.
- Новые переменные окружения (добавить в `lib/config/env.ts` и `.env.example`): `DATABASE_URL`
  (под `app`, уже есть в схеме env как optional → сделать required на этом этапе),
  `MIGRATOR_PASSWORD`, `APP_PASSWORD`.

---

## 4. Аутентификация

Подход — Lucia-style: сессии в БД, серверная валидация по cookie. Без JWT (отзыв и инвалидация
сессий тривиальны, что важно для админки). Обоснование — ADR-006.

### 4.1. Состав

- **Регистрация владельца при init** — не публичная форма, а seed-шаг (§4.2). Публичной регистрации
  в админке нет; новых пользователей заводит владелец/админ через `/admin/users` (CRUD каркас).
- **Логин** (`/admin/login`) — Server Action `login(email, password)`.
- **Логаут** — Server Action `logout()`.
- **Смена пароля** — Server Action `changePassword(old, new)` с ротацией сессий.

### 4.2. Seed владельца (закрывает заглушку init-shop, шаг 4)

```
db/seed/
  permissions.sql   -- INSERT базовых прав (ON CONFLICT DO NOTHING)
  roles.sql         -- INSERT системных ролей owner/admin/manager + role_permissions
  owner.mjs         -- создаёт владельца из .env (OWNER_EMAIL/OWNER_PASSWORD), хеш argon2
```

- `owner.mjs` идемпотентен: если пользователь с `OWNER_EMAIL` уже есть — ничего не делает.
- Пароль владельца: либо из `OWNER_PASSWORD` (.env), либо генерируется и **печатается один раз** в
  консоль init-скрипта с требованием сменить при первом входе. В репозитории пароля нет.
- Владелец создаётся с `is_owner = true` и привязкой к системной роли `owner`.

### 4.3. Хеширование паролей

- **Алгоритм: argon2id** (ADR-006). Параметры по умолчанию из библиотеки `@node-rs/argon2`
  (memoryCost/timeCost подобрать под целевой VPS; зафиксировать в `lib/auth/password.ts`).
- Хеш — PHC-строка, хранится в `users.password_hash`. Соль внутри строки.
- Эскизы сигнатур:

```ts
// lib/auth/password.ts (эскиз)
export async function hashPassword(plain: string): Promise<string>;        // argon2id → PHC
export async function verifyPassword(hash: string, plain: string): Promise<boolean>;
```

### 4.4. Защита от timing-атак

- При логине: если пользователь не найден — **всё равно выполнить фиктивную проверку argon2**
  (по заранее заготовленному dummy-хешу), чтобы время ответа не зависело от существования email.
- Возвращать **единое сообщение** «неверный email или пароль» (не раскрывать, что именно неверно).
- Сравнение токенов/идентификаторов сессии — побайтово константного времени (`timingSafeEqual`),
  хотя при PK-поиске по `sessions.id` это менее критично.

### 4.5. Rate-limit на логин (Redis)

- Ключ `login:fail:{ip}` и `login:fail:{email}`; инкремент при неудаче, окно + порог (например
  10 попыток / 15 мин), затем временная блокировка. Хранилище — **Redis** (`REDIS_URL`), т.к.
  in-process не масштабируется (ADR-002).
- Эскиз:

```ts
// lib/auth/rate-limit.ts (эскиз)
export async function checkLoginRate(key: string): Promise<{ allowed: boolean; retryAfterSec?: number }>;
export async function registerLoginFailure(key: string): Promise<void>;
export async function resetLoginFailures(key: string): Promise<void>;  // при успехе
```
- **Mock-режим:** если `REDIS_URL` не задан (магазин без Redis на demo) — fallback на in-memory
  бэкенд (`MemoryRateBackend`) с одноразовым warn. Это полноценный счётчик в памяти процесса
  (а не «всегда allowed»): семантика fixed-window сохраняется, но не масштабируется между
  инстансами. Соответствует требованию mock-режима зависимостей (`docs/02`, роадмап п.5).
- **Защита от OOM в mock-режиме (волна 6, баг B):** `MemoryRateBackend` ограничивает размер Map
  сверху (`MEMORY_RATE_MAX_ENTRIES`, по умолчанию 10 000). Без этого storefront-путь (ключ ведра
  = по IP, `reset` не вызывается) уязвим: атакующий ротацией валидных `X-Forwarded-For` вставлял
  лавину никогда-не-перечитываемых записей → неограниченный рост Map → OOM. Политика при
  достижении предела: сначала ленивая очистка истёкших (по window-expiry), затем вытеснение
  наименее опасных активных записей — с минимальным `count` (флуд создаёт `count=1`, тогда как
  ключи у порога блокировки удерживаются, чтобы вытеснение не «амнистировало» жертву brute-force).
  Прод с Redis не затронут (`EXPIRE` чистит ключи сам). Размер задаётся конструктором
  `new MemoryRateBackend(maxEntries)` (используется в тестах для малого предела).

### 4.6. Cookie и сессии

- Кука сессии: имя `admik_session`, флаги `httpOnly`, `Secure` (в проде), `SameSite=Lax`,
  `Path=/`, срок = `expires_at` сессии (например, 30 дней скользящего окна с обновлением).
- Валидация на каждом запросе к `/admin/*` (см. middleware/гвард §5.3): найти сессию по id,
  проверить `expires_at > now()` и `users.status = 'active'`; при необходимости продлить.
- Логаут: удалить строку `sessions`, очистить куку.

### 4.7. Паттерн Server Action (ADR-002)

Единая обёртка для всех мутаций: **`guard → Zod → БД → инвалидация → audit`**.

```ts
// lib/server/action.ts (эскиз)
type ActionCtx = { user: AuthUser; ip: string; userAgent?: string };

export function defineAction<I, O>(opts: {
  permission?: PermissionCode;                 // требуемое право (guard)
  input: ZodSchema<I>;                          // Zod-валидация входа
  handler: (data: I, ctx: ActionCtx) => Promise<{ result: O; audit?: AuditEntry; revalidate?: string[] }>;
}): (raw: unknown) => Promise<ActionResult<O>>;
```

Поток внутри обёртки:
1. **guard** — получить сессию/пользователя; проверить `permission` (§5). Нет права → отказ + (опц.) аудит попытки.
2. **Zod** — `input.parse(raw)`; ошибки валидации → структурированный ответ для формы.
3. **БД** — выполнить мутацию (`postgres.js`, параметризовано).
4. **инвалидация** — `revalidatePath(...)` для затронутых путей.
5. **audit** — если `handler` вернул `audit`, записать через helper (§7), добавив `actor/ip/ua`.

Идемпотентность форм (анти-дабл-сабмит, паттерн 2x2) — опционально через токен идемпотентности
формы, перенесём детально в задачу 1.6 (паттерн Server Action в роадмапе).

---

## 5. RBAC

### 5.1. Выбор модели: гибкие права, а не enum-роли (обоснование)

| Критерий | enum-роли (роль зашита в коде) | гибкие роли+права (выбрано) |
|---|---|---|
| Универсальность для разных магазинов | низкая: каждый магазин хочет свой набор ролей | высокая: роли настраиваются данными, не кодом |
| Новый модуль | правка enum + кода всех проверок | добавить `permissions` строкой, привязать к ролям |
| Принцип «копи-paste без правки кода» (ADR-003) | нарушается | соблюдается (отличия — в данных/seed) |
| Гранулярность | грубая (роль = всё или ничего) | точная (`catalog.read` vs `catalog.write`) |
| Сложность | ниже | умеренно выше (4 таблицы + seed) |

**Решение (ADR-005):** гибкая модель `users —< user_roles >— roles —< role_permissions >— permissions`.
Проверки в коде идут **по правам** (`requirePermission('orders.write')`), не по именам ролей. Роли —
это лишь удобные наборы прав, настраиваемые на магазин. Это прямо вытекает из принципа универсальности
платформы (CLAUDE.md) и ADR-003.

### 5.2. Модель прав (permissions)

Формат кода: **`<домен>.<действие>`**. Базовый набор (seed) Этапа 1 + заготовки под модули:

| Код | Модуль | Назначение |
|---|---|---|
| `users.read` / `users.manage` | core | просмотр / управление пользователями и ролями |
| `roles.manage` | core | управление ролями и привязкой прав |
| `audit.read` | core | просмотр журнала аудита |
| `settings.manage` | core | настройки магазина (заглушка под Этап 5) |
| `catalog.read` / `catalog.write` | catalog | (заготовка) чтение/изменение каталога |
| `orders.read` / `orders.write` | orders | (заготовка) чтение/изменение заказов |
| `cdek.manage` | cdek | (заготовка) управление доставкой |
| `cms.read` / `cms.write` | cms | (заготовка) управление контентом |

> Права модулей сидируются всегда, но в меню/UI отражаются только при включённом модуле
> (`isModuleEnabled`). Это разделяет «право есть в системе» и «модуль показан».

Базовые системные роли (seed, `is_system = true`):
- **owner** — `is_owner`-пользователь; формально имеет все права (проверка короткозамкнута, §5.4).
- **admin** — все `*.read` + `*.write`/`*.manage` core, catalog, orders, cms, cdek (кроме защиты owner-операций).
- **manager** — `orders.read/write`, `catalog.read`, `cdek.manage`, `audit.read` (операционная работа).

### 5.3. Функция проверки доступа и гварды

```ts
// lib/auth/rbac.ts (эскиз)
export type PermissionCode = 'users.read' | 'users.manage' | 'roles.manage'
  | 'audit.read' | 'settings.manage' | 'catalog.read' | 'catalog.write'
  | 'orders.read' | 'orders.write' | 'cdek.manage' | 'cms.read' | 'cms.write';

export interface AuthUser {
  id: string; email: string; isOwner: boolean;
  permissions: Set<PermissionCode>;     // эффективные права = объединение прав всех ролей
}

// Базовая проверка (чистая функция, легко тестируется матрицей роль→право).
export function can(user: AuthUser, perm: PermissionCode): boolean;
// = user.isOwner || user.permissions.has(perm)

// Гвард для Server Actions / loaders: бросает Forbidden, если нет права.
export function requirePermission(user: AuthUser, perm: PermissionCode): void;

// Получение текущего пользователя из сессии (для роутов/actions).
export async function getCurrentUser(): Promise<AuthUser | null>;
export async function requireUser(): Promise<AuthUser>;   // редирект на /admin/login, если нет
```

- **Гвард для роутов:** в `middleware.ts` (или layout-loader) — проверка наличия валидной сессии для
  всех `/admin/*` кроме `/admin/login`; неавторизованный → redirect на логин.
- **Гвард для действий:** `defineAction({ permission })` (§4.7) вызывает `requirePermission`.
- **Двойная защита:** UI скрывает недоступные пункты (§6), но **решение принимает сервер** —
  скрытие в UI не является защитой (критерий DoD).

### 5.4. Роль супер-владельца

- Пользователь с `users.is_owner = true` проходит `can()` всегда (`return true` до проверки множества).
- Owner-аккаунт нельзя отключить/удалить через обычный UI (защита от само-локаута: запрет удаления
  последнего owner). Роль `owner` системная (`is_system`), её `code` неизменяем.
- Назначить нового владельца может только действующий владелец (право/проверка `is_owner`).

---

## 6. Каркас админки (`/admin/*`, App Router)

### 6.1. Структура маршрутов

```
app/admin/
  layout.tsx              # каркас: сайдбар-навигация + топбар; requireUser() в loader
  page.tsx                # дашборд-заглушка (карточки-метрики позже)
  login/
    page.tsx              # форма логина (без admin-layout); Server Action login()
  users/
    page.tsx              # список пользователей (TanStack Table) — право users.read
    [id]/page.tsx         # карточка/редактирование — право users.manage
  roles/
    page.tsx              # роли и привязка прав — право roles.manage
  audit/
    page.tsx              # журнал аудита (фильтры) — право audit.read
```

- `/admin/login` — вне общего layout (или layout пропускает навигацию для неавторизованных).
- Все прочие `/admin/*` защищены гвардом сессии (§5.3).

### 6.2. Layout и навигация

- `app/admin/layout.tsx`: серверный компонент, вызывает `requireUser()`, получает `AuthUser`,
  строит меню функцией `buildAdminNav(user)`.
- Брендинг: `SHOP_NAME`, `SHOP_LOGO_URL` из `.env` (на Этапе 1; позже — из таблицы настроек, Этап 5).
  Никаких хардкодов конкретного магазина.

### 6.3. Состав меню = f(включённые модули, права)

```ts
// lib/admin/nav.ts (эскиз)
interface NavItem { href: string; label: string; permission?: PermissionCode; module?: ModuleName; }

const NAV: NavItem[] = [
  { href: '/admin',        label: 'Дашборд' },
  { href: '/admin/catalog',label: 'Каталог',  permission: 'catalog.read', module: 'catalog' },
  { href: '/admin/orders', label: 'Заказы',   permission: 'orders.read',  module: 'orders'  },
  { href: '/admin/cdek',   label: 'Доставка', permission: 'cdek.manage',  module: 'cdek'    },
  { href: '/admin/cms',    label: 'Контент',  permission: 'cms.read',     module: 'cms'     },
  { href: '/admin/users',  label: 'Пользователи', permission: 'users.read' },
  { href: '/admin/roles',  label: 'Роли',     permission: 'roles.manage' },
  { href: '/admin/audit',  label: 'Аудит',    permission: 'audit.read' },
];

// Волна 5: набор модулей — ЭФФЕКТИВНЫЙ (env⊕БД-оверрайд), передаётся параметром.
export function buildAdminNav(
  user: AuthUser,
  enabledModules: ReadonlySet<ModuleName> | readonly ModuleName[],
): NavItem[] {
  const enabled = enabledModules instanceof Set ? enabledModules : new Set(enabledModules);
  return NAV.filter(i =>
    (!i.module || enabled.has(i.module)) &&         // выключенный модуль скрыт
    (!i.permission || can(user, i.permission))     // нет права — пункт скрыт
  );
}
```

- На Этапе 1 реально существуют только `Дашборд`, `Пользователи`, `Роли`, `Аудит`. Пункты модулей —
  заготовки, появятся в Этапах 2–5 (но логика фильтрации по модулю/праву уже готова и тестируется).
- **Волна 5:** `buildAdminNav` больше не читает `process.env` сам — `layout.tsx` передаёт эффективный
  набор модулей из `getEffectiveModuleSet()` (env⊕БД). Так меню реагирует на выключение модуля из UI
  (`module_overrides`), а не только на `ADMIK_MODULES`. Функция остаётся чистой и детерминированной.

### 6.4. Страница логина и дашборд

- `login/page.tsx` — форма (email/пароль) → Server Action `login`; ошибки показываются единым
  сообщением (§4.4); после успеха — redirect на `/admin`.
- `page.tsx` (дашборд) — заглушка с приветствием и плейсхолдерами метрик; наполнится в модулях.

---

## 7. `audit_log`

### 7.1. Что логируем (Этап 1)

- `auth.login` (успех), `auth.login_failed` (неудача — без пароля), `auth.logout`.
- `user.create` / `user.update` / `user.disable`, `auth.password_change`.
- `role.create` / `role.update`, `role.grant` / `role.revoke` (привязка прав/ролей).
- Любая мутация через `defineAction`, у которой `handler` вернул `audit`.

### 7.2. Единый helper записи

```ts
// lib/audit/log.ts (эскиз)
export interface AuditEntry {
  action: string;                 // 'user.update'
  entityType?: string;            // 'user'
  entityId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export async function writeAudit(entry: AuditEntry, ctx: {
  actorUserId?: string; actorEmail?: string; ip?: string; userAgent?: string;
}): Promise<void>;
```

- **Санитизация:** helper вырезает чувствительные поля (`password_hash`, `password`, токены) из
  `before`/`after` перед записью.
- **Append-only:** запись только `INSERT`; роль `app` лишена `UPDATE/DELETE` на `audit_log` (§3.4).
- Вызывается централизованно из `defineAction` (§4.7), чтобы аудит был не «по желанию», а частью
  пайплайна мутаций.

---

## 8. Декомпозиция Этапа 1 на задачи (порядок выполнения, «сначала тесты»)

Порядок согласован с `docs/03-роадмап.md` (раздел «Ближайшие шаги», п. 2). У каждой задачи —
сперва тесты (ADR-004), затем реализация до зелёного.

### 1.1. Слой доступа к БД + движок миграций
- **Тесты (первыми):**
  - Vitest: двойной накат миграций на временную тестовую БД не падает и не меняет данные (идемпотентность).
  - Vitest: существуют роли `admik_app`/`admik_migrator`; `app` не может `DROP`/`ALTER` таблицу
    и не может `UPDATE/DELETE audit_log`.
  - Vitest: запросы идут через tagged templates `postgres.js` (нет конкатенации строк → анти-SQLi).
- **Реализация:** `lib/db/client.ts` (`app`-подключение), runner миграций (либо опора на
  `init-shop.sh` + `schema_migrations`), файлы `0001…0004`.
- **Приёмка:** накат одной командой на пустую БД; повтор безопасен; роли разделены.

### 1.2. Аутентификация (Lucia-подход, сессии в БД)
- **Тесты (первыми):**
  - hash/verify argon2id (корректность, разные соли → разные хеши).
  - timing: неизвестный email и неверный пароль дают сопоставимое время ответа (фиктивная проверка).
  - сессии: создание/валидация/истечение/удаление; продление окна; инвалидация при `status=disabled`.
  - rate-limit: блокировка после N неудач; сброс при успехе; mock-fallback без Redis.
- **Реализация:** `users`/`sessions` (в миграциях), `lib/auth/{password,session,rate-limit}.ts`,
  Server Actions `login`/`logout`/`changePassword`, cookie `admik_session`.
- **Приёмка:** вход/выход работают; неверные креды — единое сообщение + timing-защита; кука
  `httpOnly/Secure/SameSite=Lax`; rate-limit активен.

### 1.3. RBAC (роли и права)
- **Тесты (первыми):**
  - матрица «роль → права»: `can(user, perm)` истинно/ложно по seed-наборам.
  - `requirePermission` бросает Forbidden без права; owner проходит всё.
  - запрет действия **на сервере** даже при попытке вызвать Server Action напрямую.
- **Реализация:** таблицы RBAC (миграция `0003`), seed прав/ролей, `lib/auth/rbac.ts`
  (`can`/`requirePermission`/`getCurrentUser`).
- **Приёмка:** действие без права блокируется сервером; роли конфигурируемы данными; owner всесилен.

### 1.6. Унифицированный паттерн Server Action  *(идёт раньше audit/каркаса — он их фундамент)*
- **Тесты (первыми):** прохождение пайплайна `guard → Zod → БД → invalidate → audit`;
  отказ при отсутствии права; структурированные ошибки валидации; (опц.) идемпотентность формы.
- **Реализация:** `lib/server/action.ts` (`defineAction`), типы `ActionCtx`/`ActionResult`.
- **Приёмка:** все последующие мутации используют единый паттерн; покрыто тестами.

### 1.5. Сквозной аудит (`audit_log`)
- **Тесты (первыми):** запись при ключевых действиях; неизменяемость (нет UPDATE/DELETE под `app`);
  корректные метаданные (actor/ip/ua/before/after); санитизация чувствительных полей.
- **Реализация:** миграция `0004`, `lib/audit/log.ts` (`writeAudit`), интеграция в `defineAction`,
  страница `/admin/audit` (просмотр/фильтры) под правом `audit.read`.
- **Приёмка:** значимые действия фиксируются; журнал виден в админке; пароли не попадают в аудит.

### 1.4. Каркас админ-панели (layout, навигация, меню по модулям и правам)
- **Тесты (первыми, Playwright):** a11y базовых страниц; навигация рендерится; пункт скрыт при
  выключенном модуле; пункт скрыт без права; редирект неавторизованного на `/admin/login`.
- **Реализация:** `app/admin/layout.tsx`, `app/admin/page.tsx` (дашборд-заглушка),
  `app/admin/login/page.tsx`, каркас `users`/`roles`/`audit`, `lib/admin/nav.ts`,
  гвард сессии (`middleware.ts`/layout-loader), брендинг из `.env`.
- **Приёмка:** каркас единый и брендируемый конфигом; выключенный модуль не показывает раздел;
  a11y зелёные.

### 1.7. Seed владельца + интеграция в init-shop (закрытие заглушки)
- **Тесты (первыми):** идемпотентность seed (повтор не плодит владельца/роли); владелец создаётся
  из `.env`; пароль не в репозитории; роли/права сидируются.
- **Реализация:** `db/seed/{permissions.sql,roles.sql,owner.mjs}`; подключение seed на шаге 4
  `scripts/init-shop.sh` (с DevOps-агентом); новые env-переменные (`OWNER_EMAIL`,`OWNER_PASSWORD`,
  `APP_PASSWORD`,`MIGRATOR_PASSWORD`) в `lib/config/env.ts` и `.env.example`.
- **Приёмка:** `init-shop.sh` на пустой БД доводит магазин до рабочего входа владельца; повтор безопасен.

> **Учёт универсальности (во всех задачах):** никаких хардкодов магазина; роли/права — данными, не
> кодом; флаги модулей уважаются в меню/правах; секреты — из `.env`; копи-paste-развёртывание не
> нарушается (`docs/02`, ADR-003).

---

## 9. Новые зависимости

| Пакет | Назначение | Почему он |
|---|---|---|
| `postgres` (postgres.js) | драйвер БД, tagged templates | ADR-001: параметризация = анти-SQLi; лёгкий, быстрый |
| `@node-rs/argon2` | хеширование паролей argon2id | ADR-006: argon2id — рекомендация OWASP; нативная скорость; PHC-строки |
| `oslo` (или `@oslojs/crypto` + `@oslojs/encoding`) | криптослучайные id сессий, константное сравнение | Lucia-экосистема; генерация session id с нужной энтропией, `timingSafeEqual` |
| `ioredis` | rate-limit/кеш в Redis | ADR-002: масштабируемый rate-limit (in-process не годится) |
| `zod` | валидация входа Server Actions | уже в стеке (ADR-001), используется в `defineAction` |

- **`@node-rs/argon2` vs `bcrypt`:** выбираем argon2id (память-hard, устойчивее к GPU-перебору).
  `bcrypt` допустим как fallback, но по умолчанию — argon2id (ADR-006).
- **`oslo`:** Lucia как фреймворк в мейнтенанс-режиме, поэтому берём её низкоуровневые примитивы
  (oslo) и реализуем тонкий слой сессий сами — это и есть «Lucia-подход» из ADR-001, без жёсткой
  зависимости от пакета `lucia`.
- Все пакеты ставятся через pnpm (ADR-001), фиксируются в lock-файле (задача 0.10).

---

## 10. Резюме принятых решений (для журнала)

1. **RBAC — гибкая модель** `users—user_roles—roles—role_permissions—permissions` (ADR-005), проверки
   в коде идут **по правам** (`catalog.read`, `orders.write`, `users.manage`), а не по именам ролей.
   Роли — настраиваемые данными наборы прав → универсальность и копи-paste без правки кода.
2. **Auth — Lucia-подход** (сессии в БД, не JWT): argon2id-хеши (ADR-006), httpOnly/Secure/SameSite
   cookie, защита от timing-атак (фиктивная проверка + единое сообщение), rate-limit на Redis с
   mock-fallback. Owner — флаг `is_owner`, проходит все проверки; защита от само-локаута.
3. **Аудит** — таблица `audit_log` (actor/action/entity/before→after JSONB/ip), единый helper
   `writeAudit`, **append-only на уровне прав БД** (роль `app` без UPDATE/DELETE), интеграция в
   паттерн Server Action; чувствительные поля санитизируются.
4. **Миграции** — `db/migrations/NNNN_*.sql`, идемпотентные, лексикографический порядок, совместимы
   с существующим `scripts/init-shop.sh`; журнал `schema_migrations`; две роли БД `app`/`migrator`
   (ADR-006). Seed (права/роли/владелец) — отдельный шаг, закрывает заглушку init-shop.
5. **Каркас админки** — `/admin/*` (App Router), меню = f(включённые модули + права пользователя),
   брендинг из `.env`; сервер — единственный источник решений о доступе.
6. **Новые зависимости:** `postgres`, `@node-rs/argon2`, `oslo`, `ioredis` (+ уже имеющийся `zod`).

### Список задач Этапа 1 (порядок выполнения)

1. **1.1** Слой БД + движок идемпотентных миграций + роли `app`/`migrator` (тесты: идемпотентность, разделение ролей, анти-SQLi).
2. **1.2** Аутентификация: `users`/`sessions`, argon2id, сессии-cookie, timing-защита, rate-limit Redis (тесты: hash/verify, timing, сессии, rate-limit).
3. **1.3** RBAC: таблицы ролей/прав + seed + `can`/`requirePermission` (тесты: матрица роль→право, серверный запрет, owner).
4. **1.6** Унифицированный паттерн Server Action `defineAction` (тесты: guard→Zod→БД→invalidate→audit).
5. **1.5** `audit_log` + `writeAudit` + `/admin/audit` (тесты: запись, неизменяемость, метаданные, санитизация).
6. **1.4** Каркас админки: layout/навигация/логин/дашборд, меню по модулям и правам (тесты Playwright: a11y, скрытие пунктов, редирект).
7. **1.7** Seed владельца + интеграция в `init-shop.sh`, новые env-переменные (тесты: идемпотентность seed, владелец из .env).
