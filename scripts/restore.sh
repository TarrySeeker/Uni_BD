#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — восстановление БД и медиа из бэкапа (Этап 6, пакет 6.2)
# =============================================================================
# ВНИМАНИЕ: операция ПЕРЕЗАПИСЫВАЕТ данные целевой БД (pg_restore --clean).
# Запускается ВРУЧНУЮ при аварийном восстановлении. Защита от случайного
# запуска: требуется CONFIRM=yes (env) или интерактивное подтверждение.
#
# Что делает скрипт:
#   1. Выбирает дамп: аргумент-путь или «последний» из backups/db.
#   2. pg_restore --clean --if-exists в целевую БД (POSTGRES_DB).
#   3. ОПЦИОНАЛЬНО (RESTORE_MEDIA=true) — mc mirror медиа обратно в бакет.
#
# Параметры подключения/секреты — ТОЛЬКО из env (.env подхватывается).
#
# Настройка через env:
#   CONFIRM=yes                  — подтверждение перезаписи (иначе спросит/выйдет);
#   POSTGRES_USER/PASSWORD/DB    — целевая БД (как в init-shop.sh);
#   PGHOST/PGPORT                — хост/порт (дефолт postgres:5432);
#   RESTORE_MEDIA=true           — также восстановить медиа из backups/media;
#   S3_BUCKET/S3_ENDPOINT/ключи  — доступ к MinIO/S3 (для медиа).
#
# Запуск:
#   CONFIRM=yes ./scripts/restore.sh                     # последний дамп
#   CONFIRM=yes ./scripts/restore.sh backups/db/admik-...dump
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

printf "${BOLD}=== Admik · восстановление из бэкапа ===${NC}\n\n"

# -----------------------------------------------------------------------------
# Параметры
# -----------------------------------------------------------------------------
BACKUPS_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/backups}"
DB_DIR="${BACKUPS_DIR}/db"
MEDIA_DIR="${BACKUPS_DIR}/media"

export PGHOST="${PGHOST:-postgres}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${POSTGRES_USER:-}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"
export PGDATABASE="${POSTGRES_DB:-}"

MISSING=""
[ -z "${PGUSER}" ]     && MISSING="${MISSING} POSTGRES_USER"
[ -z "${PGPASSWORD}" ] && MISSING="${MISSING} POSTGRES_PASSWORD"
[ -z "${PGDATABASE}" ] && MISSING="${MISSING} POSTGRES_DB"
if [ -n "${MISSING}" ]; then
  fail "Не заданы обязательные переменные БД:${MISSING}"
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  fail "Утилита pg_restore не найдена. Установите postgresql-client."
  exit 1
fi

# -----------------------------------------------------------------------------
# Выбор дампа: аргумент-путь или «последний» из backups/db
# -----------------------------------------------------------------------------
DUMP_FILE="${1:-}"

if [ -z "${DUMP_FILE}" ]; then
  step "Дамп не указан — беру последний из ${DB_DIR}"
  if [ ! -d "${DB_DIR}" ]; then
    fail "Каталог дампов не найден: ${DB_DIR}"
    exit 1
  fi
  # Самый свежий по mtime *.dump.
  DUMP_FILE="$(find "${DB_DIR}" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' 2>/dev/null \
                | sort -nr | head -n1 | cut -d' ' -f2-)"
  if [ -z "${DUMP_FILE}" ]; then
    fail "В ${DB_DIR} нет ни одного *.dump."
    exit 1
  fi
fi

if [ ! -f "${DUMP_FILE}" ]; then
  fail "Файл дампа не найден: ${DUMP_FILE}"
  exit 1
fi
ok "Выбран дамп: ${DUMP_FILE}"

# -----------------------------------------------------------------------------
# Защита от случайного запуска (перезапись данных!)
# -----------------------------------------------------------------------------
CONFIRM_VALUE="$(printf '%s' "${CONFIRM:-}" | tr '[:upper:]' '[:lower:]')"
if [ "${CONFIRM_VALUE}" != "yes" ]; then
  warn "Эта операция ПЕРЕЗАПИШЕТ данные БД «${PGDATABASE}» на ${PGHOST}:${PGPORT}!"
  warn "pg_restore --clean удалит и пересоздаст объекты из дампа."
  if [ -t 0 ]; then
    printf "Введите ${BOLD}yes${NC} для подтверждения: "
    read -r answer
    if [ "$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]')" != "yes" ]; then
      fail "Не подтверждено — выход без изменений."
      exit 2
    fi
  else
    fail "Подтверждение не получено. Запустите с CONFIRM=yes (или в интерактивном терминале)."
    exit 2
  fi
fi

# -----------------------------------------------------------------------------
# Шаг 1. pg_restore --clean --if-exists
# -----------------------------------------------------------------------------
step "Шаг 1/2. Восстанавливаю БД «${PGDATABASE}» из дампа"

# --clean --if-exists: дропнуть существующие объекты перед созданием (без ошибок
# на отсутствующих). --no-owner/--no-acl: не зависеть от ролей конкретного сервера.
# pg_restore возвращает ненулевой код и при некритичных warning'ах — поэтому
# не валим скрипт на первом, но печатаем понятный итог.
if pg_restore --clean --if-exists --no-owner --no-acl -d "${PGDATABASE}" "${DUMP_FILE}"; then
  ok "Восстановление БД завершено."
else
  warn "pg_restore вернул ненулевой код (возможны некритичные warning'и о DROP)."
  warn "Проверьте вывод выше; если объекты восстановились — это ожидаемо для --clean."
fi

# -----------------------------------------------------------------------------
# Шаг 2. Опциональное восстановление медиа
# -----------------------------------------------------------------------------
RESTORE_MEDIA_VALUE="$(printf '%s' "${RESTORE_MEDIA:-}" | tr '[:upper:]' '[:lower:]')"
case "${RESTORE_MEDIA_VALUE}" in
  true|1|yes)
    step "Шаг 2/2. Восстанавливаю медиа обратно в бакет"
    MC_ALIAS="adminrestore"
    cleanup_mc() {
      if command -v mc >/dev/null 2>&1; then
        mc alias rm "${MC_ALIAS}" >/dev/null 2>&1 || true
      fi
    }
    if ! command -v mc >/dev/null 2>&1; then
      warn "mc не найден — медиа не восстановлено."
    elif [ ! -d "${MEDIA_DIR}" ] || [ -z "$(ls -A "${MEDIA_DIR}" 2>/dev/null)" ]; then
      warn "Каталог медиа пуст (${MEDIA_DIR}) — нечего восстанавливать."
    elif [ -z "${S3_ENDPOINT:-}" ] || [ -z "${S3_BUCKET:-}" ] || \
         [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
      warn "S3_ENDPOINT/S3_BUCKET/ключи заданы не полностью — медиа не восстановлено."
    else
      trap cleanup_mc EXIT
      if mc alias set "${MC_ALIAS}" "${S3_ENDPOINT}" \
            "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" >/dev/null 2>&1; then
        mc mb --ignore-existing "${MC_ALIAS}/${S3_BUCKET}" >/dev/null 2>&1 || true
        if mc mirror --overwrite "${MEDIA_DIR}/" "${MC_ALIAS}/${S3_BUCKET}"; then
          ok "Медиа восстановлено в бакет ${S3_BUCKET}."
        else
          warn "mc mirror (обратно) завершился с ошибкой."
        fi
      else
        warn "Не удалось подключиться к S3 — медиа не восстановлено."
      fi
      cleanup_mc
      trap - EXIT
    fi
    ;;
  *)
    ok "Восстановление медиа пропущено (RESTORE_MEDIA не задан/false)."
    ;;
esac

printf "\n${GREEN}${BOLD}Готово.${NC} Восстановлено из: %s\n" "${DUMP_FILE}"
exit 0
