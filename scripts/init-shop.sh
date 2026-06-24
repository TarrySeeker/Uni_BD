#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — инициализация нового магазина (init-shop)
# =============================================================================
# Этот скрипт запускает НЕ разработчик, а сторонний человек при развёртывании
# нового магазина. Поэтому каждый шаг подробно прокомментирован и выводит
# понятные сообщения.
#
# Что делает скрипт:
#   1. Проверяет, что файл .env существует и заполнен.
#   2. Ждёт, пока база данных PostgreSQL станет доступна.
#   3. Накатывает миграции из db/migrations/*.sql (идемпотентно — повторный
#      запуск безопасен).
#   4. Заполняет начальные данные (seed): права, роли, владелец.
#   5. ОПЦИОНАЛЬНО (если SEED_DEMO_CATALOG=true) — наполняет демо-каталогом.
#
# Скрипт ИДЕМПОТЕНТЕН: его можно запускать повторно без вреда для данных.
#
# Запуск:
#   ./scripts/init-shop.sh
# =============================================================================

# Строгий режим: падать при ошибке, при обращении к необъявленной переменной
# и при ошибке в любой команде конвейера.
set -euo pipefail

# Цвета для наглядного вывода (если терминал поддерживает).
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi

# Вспомогательные функции вывода шагов.
step()  { printf "${BOLD}==>${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✔${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  ⚠${NC} %s\n" "$1"; }
fail()  { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

# Безопасная загрузка KEY=VALUE из .env в окружение БЕЗ shell-eval: значение
# берётся дословно (всё после первого '='), без word-splitting и глоббинга — как
# env_file в docker compose. Поддерживает префикс `export `, комментарии (#),
# пустые строки и снятие одной пары окружающих кавычек. Это устойчиво к значениям
# вида `BACKUP_CRON=0 3 * * *` и `SHOP_NAME=Мой магазин`, которые ломали `. .env`
# (word-splitting → «3: command not found», глоббинг «*»).
load_env_file() {
  local file="$1" line key value
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line#"${line%%[![:space:]]*}"}"        # срезаем ведущие пробелы
    [ -z "${line}" ] && continue                    # пустая строка
    case "${line}" in \#*) continue ;; esac         # комментарий
    case "${line}" in export\ *) line="${line#export }" ;; esac
    case "${line}" in *=*) : ;; *) continue ;; esac # не KEY=VALUE — пропускаем
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;; esac
    case "${value}" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "${key}=${value}"
  done < "${file}"
}

# Определяем корень проекта (на уровень выше каталога scripts),
# чтобы скрипт работал из любой директории.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

MIGRATIONS_DIR="${PROJECT_ROOT}/db/migrations"

printf "${BOLD}=== Admik · инициализация магазина ===${NC}\n\n"

# -----------------------------------------------------------------------------
# Шаг 1. Конфигурация: файл .env (на хосте) ИЛИ переменные окружения (в контейнере)
# -----------------------------------------------------------------------------
step "Шаг 1/5. Проверяю конфигурацию (.env / переменные окружения)"

# Конфигурация приходит ДВУМЯ способами:
#   • на хосте — файлом .env рядом с проектом (его заполняет владелец магазина);
#   • ВНУТРИ контейнера app — переменными окружения (docker compose env_file),
#     при этом .env как ФАЙЛ в образ не кладётся (секреты не пекутся в образ).
# Именно так init-shop запускается штатно: `docker compose exec app …`
# (make init / scripts/deploy.sh). Поэтому файл .env ОПЦИОНАЛЕН: если есть —
# безопасно загружаем его (без shell-eval), иначе используем уже заданное окружение.
if [ -f "${PROJECT_ROOT}/.env" ]; then
  load_env_file "${PROJECT_ROOT}/.env"
  ok ".env найден и загружен"
else
  warn ".env-файл не найден — использую переменные окружения (штатно при запуске внутри контейнера app)"
fi

# Проверяем, что заданы критичные переменные подключения к БД (из файла ИЛИ окружения).
MISSING=""
[ -z "${DATABASE_URL:-}" ]      && MISSING="${MISSING} DATABASE_URL"
[ -z "${POSTGRES_USER:-}" ]     && MISSING="${MISSING} POSTGRES_USER"
[ -z "${POSTGRES_PASSWORD:-}" ] && MISSING="${MISSING} POSTGRES_PASSWORD"
[ -z "${POSTGRES_DB:-}" ]       && MISSING="${MISSING} POSTGRES_DB"

if [ -n "${MISSING}" ]; then
  fail "Не заданы обязательные переменные:${MISSING}"
  warn "На хосте: cp .env.example .env и заполните значения."
  warn "В контейнере: убедитесь, что они переданы (docker compose env_file: .env)."
  exit 1
fi
ok "Обязательные переменные заданы"

# -----------------------------------------------------------------------------
# Шаг 2. Ожидание готовности PostgreSQL
# -----------------------------------------------------------------------------
step "Шаг 2/5. Жду, пока база данных PostgreSQL станет доступна"

# Хост и порт БД: внутри docker-сети это сервис 'postgres:5432'.
# Можно переопределить через PGHOST/PGPORT при запуске вне Docker.
DB_HOST="${PGHOST:-postgres}"
DB_PORT="${PGPORT:-5432}"

# Готовим переменные окружения для psql/pg_isready, чтобы не дублировать
# параметры подключения в каждой команде. По умолчанию PG* = СУПЕРПОЛЬЗОВАТЕЛЬ
# (POSTGRES_USER) — он нужен ТОЛЬКО для bootstrap (создание ролей/расширений) и
# наката superuser-only миграций. Миграции (DDL) и seed выполняются под менее
# привилегированными ролями (admik_migrator / admik_app) через явные -U ниже —
# это и есть least-privilege на уровне СУБД (ADR-002/ADR-006).
export PGHOST="${DB_HOST}"
export PGPORT="${DB_PORT}"
export PGUSER="${POSTGRES_USER}"
export PGPASSWORD="${POSTGRES_PASSWORD}"
export PGDATABASE="${POSTGRES_DB}"

# Пароли служебных ролей: нужны и для bootstrap (создание ролей), и для
# подключения psql под этими ролями ниже. Безопасные значения по умолчанию —
# чтобы накат не падал на необъявленной переменной; для боя задайте свои в .env.
APP_PASSWORD="${APP_PASSWORD:-change-me-app-password}"
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-change-me-migrator-password}"

# Ждём готовности до 60 попыток с паузой 2с (≈2 минуты).
ATTEMPTS=60
until pg_isready -q -h "${DB_HOST}" -p "${DB_PORT}" -U "${POSTGRES_USER}" 2>/dev/null; do
  ATTEMPTS=$((ATTEMPTS - 1))
  if [ "${ATTEMPTS}" -le 0 ]; then
    fail "База данных не ответила за отведённое время."
    warn "Проверьте, что контейнер postgres запущен: docker compose ps"
    exit 1
  fi
  printf "  ... жду базу данных (%s:%s)\n" "${DB_HOST}" "${DB_PORT}"
  sleep 2
done
ok "База данных доступна (${DB_HOST}:${DB_PORT})"

# -----------------------------------------------------------------------------
# Шаг 3. Накат миграций (идемпотентно), least-privilege по ролям БД
# -----------------------------------------------------------------------------
step "Шаг 3/5. Накатываю миграции из db/migrations"

# Модель привилегий (ADR-002/ADR-006):
#   • Суперпользователь (POSTGRES_USER) — ТОЛЬКО bootstrap: создание ролей и
#     расширений (это операции, которые в стоковом postgres недоступны обычной
#     роли) + накат миграций, содержащих CREATE EXTENSION / CREATE ROLE.
#   • admik_migrator — все ПРОЧИЕ миграции (DDL): создаёт таблицы (становясь их
#     владельцем) и выдаёт точечные GRANT роли admik_app.
#   • admik_app — рантайм приложения (минимальный DML); НИКОГДА не накатывает DDL.
# Так суперпользователь не участвует в рутинном накате схемы, а audit_log
# остаётся append-only для admik_app (SELECT/INSERT без UPDATE/DELETE, 0004).

# 3.0. BOOTSTRAP суперпользователем (идемпотентно). Гарантируем, что роли,
#      расширения и таблица журнала миграций существуют ДО любого наката, а
#      admik_migrator имеет право вести журнал schema_migrations. Это снимает
#      «курицу и яйцо»: миграция 0001 создаёт роли/расширения, но накатывать её
#      под admik_migrator нельзя (роль ещё не существует, CREATE EXTENSION/ROLE
#      требуют суперпользователя). Все конструкции IF NOT EXISTS / WHERE NOT
#      EXISTS — повтор безопасен.
printf "  → bootstrap (суперпользователь): роли, расширения, журнал миграций\n"
if ! PGUSER="${POSTGRES_USER}" PGPASSWORD="${POSTGRES_PASSWORD}" \
     psql -v ON_ERROR_STOP=1 \
          -v APP_PASSWORD="${APP_PASSWORD}" \
          -v MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD}" \
          -q <<'SQL'
-- Расширения, которые миграции ждут готовыми (0001: pgcrypto/citext, 0005:
-- pg_trgm). Создаём их суперпользователем заранее, чтобы CREATE EXTENSION
-- IF NOT EXISTS в миграциях, идущих под admik_migrator, был безопасным no-op.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Роли БД. CREATE ROLE не поддерживает IF NOT EXISTS → идемпотентность через
-- SELECT ... \gexec (роль есть → 0 строк → no-op). %L безопасно квотирует пароль.
SELECT format('CREATE ROLE admik_migrator LOGIN PASSWORD %L', :'MIGRATOR_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admik_migrator')
\gexec
SELECT format('CREATE ROLE admik_app LOGIN PASSWORD %L', :'APP_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admik_app')
\gexec

-- Базовые права на схему: migrator владеет DDL, app — только USAGE.
GRANT ALL   ON SCHEMA public TO admik_migrator;
GRANT USAGE ON SCHEMA public TO admik_app;

-- Журнал применённых миграций. Создаём здесь, чтобы admik_migrator мог вести
-- его при последующем накате (миграции под migrator пишут сюда INSERT).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text         PRIMARY KEY,
  name        text         NOT NULL,
  applied_at  timestamptz  NOT NULL DEFAULT now()
);
-- migrator ведёт журнал; app только читает (диагностика).
GRANT SELECT, INSERT, UPDATE ON schema_migrations TO admik_migrator;
GRANT SELECT                 ON schema_migrations TO admik_app;
SQL
then
  fail "Ошибка bootstrap БД (создание ролей/расширений суперпользователем)."
  exit 1
fi
ok "Bootstrap выполнен (роли admik_migrator/admik_app, расширения, журнал)"

if [ ! -d "${MIGRATIONS_DIR}" ]; then
  warn "Каталог ${MIGRATIONS_DIR} не найден — пропускаю миграции."
else
  # Считаем .sql-файлы. nullglob, чтобы пустой шаблон не дал имя '*.sql'.
  shopt -s nullglob
  MIGRATION_FILES=("${MIGRATIONS_DIR}"/*.sql)
  shopt -u nullglob

  if [ "${#MIGRATION_FILES[@]}" -eq 0 ]; then
    warn "Файлы миграций (*.sql) не найдены — пропускаю."
  else
    # Накатываем по порядку имён (миграции нумерованы: 0001_, 0002_, ...).
    # Миграции идемпотентны (CREATE ... IF NOT EXISTS) → повтор безопасен.
    for migration in $(printf '%s\n' "${MIGRATION_FILES[@]}" | sort); do
      name="$(basename "${migration}")"

      # Выбор роли наката (least-privilege): по умолчанию admik_migrator. Файлы с
      # CREATE EXTENSION / CREATE ROLE требуют суперпользователя (стоковый postgres
      # не даёт это обычной роли) — их накатываем суперпользователем. Расширения и
      # роли в них уже созданы bootstrap'ом выше, поэтому это в основном no-op, но
      # сами таблицы/GRANT из таких файлов корректно отработают под суперпользователем.
      if grep -qiE 'create[[:space:]]+extension|create[[:space:]]+role' "${migration}"; then
        run_user="${POSTGRES_USER}"; run_pass="${POSTGRES_PASSWORD}"; run_label="superuser"
      else
        run_user="admik_migrator"; run_pass="${MIGRATOR_PASSWORD}"; run_label="admik_migrator"
      fi

      printf "  → применяю %s (под %s)\n" "${name}" "${run_label}"
      # ON_ERROR_STOP=1 — остановиться при первой ошибке SQL.
      # -v передаёт пароли ролей в миграцию 0001 (§3.4); прочим миграциям эти
      # переменные не нужны — лишние psql-переменные безвредны.
      if ! PGUSER="${run_user}" PGPASSWORD="${run_pass}" \
           psql -v ON_ERROR_STOP=1 \
                -v APP_PASSWORD="${APP_PASSWORD}" \
                -v MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD}" \
                -q -f "${migration}"; then
        fail "Ошибка при применении миграции ${name} (под ${run_label})."
        exit 1
      fi
    done
    ok "Миграции применены (${#MIGRATION_FILES[@]} шт.; DDL — под admik_migrator)"
  fi
fi

# -----------------------------------------------------------------------------
# Шаг 4. Seed — начальные данные (права, роли, владелец)
# -----------------------------------------------------------------------------
# Все шаги seed идемпотентны (ON CONFLICT DO NOTHING + проверка существования
# владельца), поэтому повторный запуск init-shop безопасен.
step "Шаг 4/5. Заполняю начальные данные (seed)"

SEED_DIR="${PROJECT_ROOT}/db/seed"

if [ ! -d "${SEED_DIR}" ]; then
  warn "Каталог ${SEED_DIR} не найден — пропускаю seed."
else
  # 4.1. Справочники прав и ролей — строгий порядок: сначала permissions
  #      (на них ссылается role_permissions через FK), затем roles.
  for seed_file in permissions.sql roles.sql; do
    seed_path="${SEED_DIR}/${seed_file}"
    if [ ! -f "${seed_path}" ]; then
      warn "Файл seed ${seed_file} не найден — пропускаю."
      continue
    fi
    printf "  → накатываю %s\n" "${seed_file}"
    if ! psql -v ON_ERROR_STOP=1 -q -f "${seed_path}"; then
      fail "Ошибка при накате seed ${seed_file}."
      exit 1
    fi
  done
  ok "Права и системные роли засеяны (идемпотентно)"

  # 4.2. Владелец магазина из .env (OWNER_EMAIL/OWNER_PASSWORD).
  #      owner.mjs идемпотентен: если владелец уже есть — ничего не делает.
  #      Если OWNER_PASSWORD пуст — сгенерирует пароль и напечатает ОДИН РАЗ.
  #      Подключение к БД берётся из экспортированных выше PG* (владелец БД).
  if [ -f "${SEED_DIR}/owner.mjs" ]; then
    printf "  → создаю владельца магазина (db/seed/owner.mjs)\n"
    if ! node "${SEED_DIR}/owner.mjs"; then
      fail "Ошибка при создании владельца магазина."
      exit 1
    fi
    ok "Seed владельца выполнен"
  else
    warn "Файл owner.mjs не найден — владелец не создан."
  fi
fi

# -----------------------------------------------------------------------------
# Шаг 5. ОПЦИОНАЛЬНО — демонстрационный каталог (SEED_DEMO_CATALOG=true)
# -----------------------------------------------------------------------------
# Демо-каталог — это НЕОБЯЗАТЕЛЬНЫЕ примерные данные (нейтральные категории/
# товары/варианты/остатки) для ознакомления и smoke. Боевой магазин их НЕ
# получает: по умолчанию SEED_DEMO_CATALOG не задан / false, и шаг пропускается,
# чтобы не засорять каталог демонстрационным «мусором» (универсальность, ADR-003).
# Накат идемпотентен (ON CONFLICT DO NOTHING) — повторный запуск безопасен.
step "Шаг 5/5. Демо-каталог (опционально, SEED_DEMO_CATALOG)"

DEMO_CATALOG_SQL="${SEED_DIR}/demo-catalog.sql"

# Нормализуем флаг к нижнему регистру (true/1/yes — включают демо).
SEED_DEMO_CATALOG_VALUE="$(printf '%s' "${SEED_DEMO_CATALOG:-}" | tr '[:upper:]' '[:lower:]')"

case "${SEED_DEMO_CATALOG_VALUE}" in
  true|1|yes)
    if [ ! -f "${DEMO_CATALOG_SQL}" ]; then
      warn "SEED_DEMO_CATALOG включён, но файл demo-catalog.sql не найден — пропускаю."
    else
      printf "  → накатываю demo-catalog.sql\n"
      if ! psql -v ON_ERROR_STOP=1 -q -f "${DEMO_CATALOG_SQL}"; then
        fail "Ошибка при накате демо-каталога."
        exit 1
      fi
      ok "Демо-каталог засеян (идемпотентно)"
    fi
    ;;
  *)
    ok "Демо-каталог пропущен (SEED_DEMO_CATALOG не задан/false) — каталог пуст"
    ;;
esac

# -----------------------------------------------------------------------------
# Готово
# -----------------------------------------------------------------------------
printf "\n${GREEN}${BOLD}Готово!${NC} Магазин инициализирован.\n"

# Опционально (RUN_SMOKE=true) — сразу подтвердить готовность smoke-проверкой
# (Этап 6, 6.1). По умолчанию выключено: внутри контейнера app может не быть
# curl, а сетевой доступ к публичному адресу — не всегда; поэтому печатаем
# подсказку. На хосте/в deploy.sh smoke вызывается отдельно.
RUN_SMOKE_VALUE="$(printf '%s' "${RUN_SMOKE:-}" | tr '[:upper:]' '[:lower:]')"
case "${RUN_SMOKE_VALUE}" in
  true|1|yes)
    if [ -x "${SCRIPT_DIR}/smoke.sh" ]; then
      step "Запускаю smoke-проверку готовности (RUN_SMOKE=${RUN_SMOKE})"
      "${SCRIPT_DIR}/smoke.sh"
    else
      warn "RUN_SMOKE включён, но ${SCRIPT_DIR}/smoke.sh не найден/не исполняемый — пропускаю."
    fi
    ;;
  *)
    printf "Проверьте готовность: ${BOLD}make smoke${NC} (или ${BOLD}curl http://localhost:3000/api/health${NC})\n"
    ;;
esac
