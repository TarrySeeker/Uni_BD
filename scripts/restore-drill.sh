#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — restore-drill: проверяемое восстановление бэкапа (Этап 6, пакет 6.2)
# =============================================================================
# КЛЮЧЕВОЙ проверочный артефакт: «бэкап без проверенного restore — не бэкап»
# (ADR-015). Скрипт берёт ПОСЛЕДНИЙ дамп БД, восстанавливает его в ОДНОРАЗОВУЮ
# временную БД, читает ключевые таблицы, затем УНИЧТОЖАЕТ временную БД.
#
# Боевая БД НЕ затрагивается: работаем на отдельной БД с суффиксом
# `_drill_<timestamp>` на том же сервере. Уборка временной БД гарантирована
# через trap (в т.ч. при ошибке/прерывании).
#
# Что делает скрипт:
#   1. Находит последний backups/db/*.dump.
#   2. CREATE DATABASE <db>_drill_<timestamp>.
#   3. pg_restore дампа в неё.
#   4. Smoke-SELECT count(*) по users, products, orders, audit_log.
#   5. DROP DATABASE временной БД (всегда, через cleanup-trap).
#
# exit 0 — ТОЛЬКО если restore прошёл и ключевые таблицы читаются.
#
# Параметры/секреты — ТОЛЬКО из env (.env подхватывается). Подключение к
# maintenance-БД 'postgres' (для CREATE/DROP DATABASE) — те же PG*-учётки.
#
# Запуск:
#   ./scripts/restore-drill.sh
# =============================================================================

# Строгий режим.
set -euo pipefail

# Цвета.
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi

step()  { printf "${BOLD}==>${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✔${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  ⚠${NC} %s\n" "$1"; }
fail()  { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ -f "${PROJECT_ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${PROJECT_ROOT}/.env"
  set +a
fi

printf "${BOLD}=== Admik · restore-drill (проверка восстановления) ===${NC}\n\n"

# -----------------------------------------------------------------------------
# Параметры
# -----------------------------------------------------------------------------
BACKUPS_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/backups}"
DB_DIR="${BACKUPS_DIR}/db"

export PGHOST="${PGHOST:-postgres}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${POSTGRES_USER:-}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"
# Команды CREATE/DROP DATABASE выполняем, подключаясь к maintenance-БД 'postgres'.
MAINT_DB="${POSTGRES_MAINTENANCE_DB:-postgres}"

MISSING=""
[ -z "${PGUSER}" ]     && MISSING="${MISSING} POSTGRES_USER"
[ -z "${PGPASSWORD}" ] && MISSING="${MISSING} POSTGRES_PASSWORD"
[ -z "${POSTGRES_DB:-}" ] && MISSING="${MISSING} POSTGRES_DB"
if [ -n "${MISSING}" ]; then
  fail "Не заданы обязательные переменные БД:${MISSING}"
  exit 1
fi

for bin in pg_restore psql; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    fail "Утилита ${bin} не найдена. Установите postgresql-client."
    exit 1
  fi
done

# -----------------------------------------------------------------------------
# Последний дамп
# -----------------------------------------------------------------------------
if [ ! -d "${DB_DIR}" ]; then
  fail "Каталог дампов не найден: ${DB_DIR}. Сначала запустите backup.sh."
  exit 1
fi
DUMP_FILE="$(find "${DB_DIR}" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' 2>/dev/null \
              | sort -nr | head -n1 | cut -d' ' -f2-)"
if [ -z "${DUMP_FILE}" ]; then
  fail "В ${DB_DIR} нет ни одного *.dump — нечего проверять."
  exit 1
fi
ok "Последний дамп: ${DUMP_FILE}"

# -----------------------------------------------------------------------------
# Имя одноразовой временной БД + гарантированная уборка
# -----------------------------------------------------------------------------
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
# Имя из POSTGRES_DB + суффикс. Урезаем до лимита PostgreSQL (63 символа).
DRILL_DB="$(printf '%s_drill_%s' "${POSTGRES_DB}" "${TIMESTAMP}" | cut -c1-63)"

DRILL_DROPPED=0
# shellcheck disable=SC2317  # вызывается косвенно через trap (EXIT/INT/TERM), не «недостижимо»
cleanup() {
  # Уничтожаем временную БД ВСЕГДА (в т.ч. при ошибке/прерывании), один раз.
  if [ "${DRILL_DROPPED}" -eq 0 ]; then
    DRILL_DROPPED=1
    if [ -n "${DRILL_DB:-}" ]; then
      step "Уборка: удаляю временную БД ${DRILL_DB}"
      # WITH (FORCE) — отцепить возможные подключения (PG 13+). Не валим cleanup.
      if psql -d "${MAINT_DB}" -v ON_ERROR_STOP=0 -q \
           -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\" WITH (FORCE);" >/dev/null 2>&1; then
        ok "Временная БД удалена."
      else
        # Фолбэк без FORCE (старые версии PG).
        if psql -d "${MAINT_DB}" -v ON_ERROR_STOP=0 -q \
             -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\";" >/dev/null 2>&1; then
          ok "Временная БД удалена."
        else
          warn "Не удалось удалить ${DRILL_DB} — удалите вручную: DROP DATABASE \"${DRILL_DB}\";"
        fi
      fi
    fi
  fi
}
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
# Шаг 1. Создаём одноразовую БД
# -----------------------------------------------------------------------------
step "Шаг 1/3. Создаю одноразовую БД ${DRILL_DB}"
if ! psql -d "${MAINT_DB}" -v ON_ERROR_STOP=1 -q \
      -c "CREATE DATABASE \"${DRILL_DB}\";"; then
  fail "Не удалось создать временную БД ${DRILL_DB}."
  exit 1
fi
ok "Временная БД создана."

# -----------------------------------------------------------------------------
# Шаг 2. pg_restore дампа в одноразовую БД
# -----------------------------------------------------------------------------
step "Шаг 2/3. Восстанавливаю дамп в ${DRILL_DB}"
# --no-owner/--no-acl: не зависеть от ролей. pg_restore может вернуть warning'и
# (например, отсутствующие роли) — это не делает drill проваленным; критерий
# успеха — читаемость ключевых таблиц на шаге 3.
if pg_restore --no-owner --no-acl -d "${DRILL_DB}" "${DUMP_FILE}"; then
  ok "pg_restore завершился без ошибок."
else
  warn "pg_restore вернул ненулевой код (возможны некритичные warning'и)."
  warn "Финальный вердикт — по чтению таблиц ниже."
fi

# -----------------------------------------------------------------------------
# Шаг 3. Smoke-SELECT по ключевым таблицам
# -----------------------------------------------------------------------------
step "Шаг 3/3. Читаю ключевые таблицы (SELECT count(*))"

KEY_TABLES="users products orders audit_log"
READ_FAILURES=0

for tbl in ${KEY_TABLES}; do
  # count(*) — подтверждает, что таблица существует и читается. ON_ERROR_STOP=1,
  # -tA: «голое» значение без рамки/шапки.
  if cnt="$(psql -d "${DRILL_DB}" -v ON_ERROR_STOP=1 -tA \
             -c "SELECT count(*) FROM ${tbl};" 2>/dev/null)"; then
    ok "${tbl}: count = ${cnt}"
  else
    fail "${tbl}: НЕ читается (таблица отсутствует или дамп повреждён)."
    READ_FAILURES=$((READ_FAILURES + 1))
  fi
done

# -----------------------------------------------------------------------------
# Вердикт (cleanup выполнится автоматически по trap EXIT)
# -----------------------------------------------------------------------------
printf "\n"
if [ "${READ_FAILURES}" -eq 0 ]; then
  printf "${GREEN}${BOLD}Restore-drill OK${NC} — дамп восстановлен, ключевые таблицы читаются.\n"
  exit 0
fi

fail "Restore-drill FAILED — таблиц не прочитано: ${READ_FAILURES}. БЭКАП НЕРАБОЧИЙ."
exit 1
