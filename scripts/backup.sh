#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — бэкап БД и медиа (Этап 6, пакет 6.2)
# =============================================================================
# Делает СОГЛАСОВАННЫЙ бэкап магазина: логический дамп PostgreSQL + зеркало
# медиа из MinIO/S3, с ретенцией по N дней. Том Docker — НЕ бэкап (не спасает
# от удаления/коррупции/`docker volume rm`), поэтому делаем переносимые файлы.
#
# Что делает скрипт:
#   1. Дамп БД: pg_dump -Fc (custom-формат: сжатие + гибкий pg_restore) в
#      backups/db/<shop>-<UTC-timestamp>.dump.
#   2. Медиа: mc mirror бакета S3_BUCKET в backups/media/. Если MinIO/mc
#      недоступны (чистый dev без медиа) — gracefully пропускаем с warning.
#   3. Ретенция: удаляем файлы старше BACKUP_RETENTION_DAYS (дефолт 14) в
#      backups/db и backups/media.
#
# Порядок «сперва БД, затем медиа» (§6.2): медиа аддитивно, удалённый позже
# файл лучше, чем отсутствующая в дампе картинка («eventually consistent backup»).
#
# Параметры подключения и секреты — ТОЛЬКО из env (.env подхватывается, если
# рядом). Ничего магазино-специфичного не хардкодится (ADR-003).
#
# Настройка через env:
#   POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB — учётка БД (как в init-shop.sh);
#   PGHOST/PGPORT                — хост/порт БД (дефолт postgres:5432);
#   SHOP_NAME / COMPOSE_PROJECT_NAME — имя магазина в имени дампа (дефолт admik);
#   S3_BUCKET/S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY — доступ к MinIO/S3;
#   BACKUP_RETENTION_DAYS        — сколько дней хранить (дефолт 14).
#
# Код возврата: 0 — дамп БД создан (медиа может быть пропущено); ≠0 — провал БД.
#
# Запуск:
#   ./scripts/backup.sh
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

step()  { printf "${BOLD}==>${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✔${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  ⚠${NC} %s\n" "$1"; }
fail()  { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

# Определяем корень проекта (на уровень выше каталога scripts),
# чтобы скрипт работал из любой директории и нашёл .env.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Подхватываем .env, если он есть рядом (для PG*/S3*/BACKUP_*).
if [ -f "${PROJECT_ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${PROJECT_ROOT}/.env"
  set +a
fi

printf "${BOLD}=== Admik · бэкап БД и медиа ===${NC}\n\n"

# -----------------------------------------------------------------------------
# Параметры (всё из env, безопасные дефолты)
# -----------------------------------------------------------------------------
# Имя магазина: SHOP_NAME → COMPOSE_PROJECT_NAME → admik. Чистим от пробелов и
# опасных для имени файла символов, чтобы получить безопасный префикс.
SHOP_RAW="${SHOP_NAME:-${COMPOSE_PROJECT_NAME:-admik}}"
SHOP="$(printf '%s' "${SHOP_RAW}" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"
[ -n "${SHOP}" ] || SHOP="admik"

# Каталоги бэкапов (том backups:/backups в проде; в dev — ./backups).
BACKUPS_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/backups}"
DB_DIR="${BACKUPS_DIR}/db"
MEDIA_DIR="${BACKUPS_DIR}/media"

# Ретенция в днях.
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# UTC-метка времени для имени файла (стабильно сортируется лексикографически).
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Параметры подключения к БД (те же имена, что в init-shop.sh).
export PGHOST="${PGHOST:-postgres}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${POSTGRES_USER:-}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"
export PGDATABASE="${POSTGRES_DB:-}"

# -----------------------------------------------------------------------------
# Проверка обязательных параметров БД
# -----------------------------------------------------------------------------
MISSING=""
[ -z "${PGUSER}" ]     && MISSING="${MISSING} POSTGRES_USER"
[ -z "${PGPASSWORD}" ] && MISSING="${MISSING} POSTGRES_PASSWORD"
[ -z "${PGDATABASE}" ] && MISSING="${MISSING} POSTGRES_DB"
if [ -n "${MISSING}" ]; then
  fail "Не заданы обязательные переменные БД:${MISSING}"
  warn "Заполните .env (как для init-shop.sh) и запустите снова."
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  fail "Утилита pg_dump не найдена. Установите postgresql-client."
  exit 1
fi

# Создаём каталоги бэкапов при отсутствии.
mkdir -p "${DB_DIR}" "${MEDIA_DIR}"

# -----------------------------------------------------------------------------
# Шаг 1. Дамп БД (pg_dump -Fc)
# -----------------------------------------------------------------------------
step "Шаг 1/3. Делаю дамп БД (${PGDATABASE} @ ${PGHOST}:${PGPORT})"

DUMP_FILE="${DB_DIR}/${SHOP}-${TIMESTAMP}.dump"

# -Fc — custom-формат: сжатие + гибкий pg_restore (--clean/--if-exists, выбор
# таблиц). Пишем во временный файл, переименовываем по успеху — чтобы оборванный
# дамп не выглядел готовым.
TMP_DUMP="${DUMP_FILE}.partial"
if pg_dump -Fc --no-owner --no-acl -f "${TMP_DUMP}"; then
  mv "${TMP_DUMP}" "${DUMP_FILE}"
  DUMP_SIZE="$(du -h "${DUMP_FILE}" 2>/dev/null | cut -f1)"
  ok "Дамп БД создан: ${DUMP_FILE} (${DUMP_SIZE:-?})"
else
  rm -f "${TMP_DUMP}"
  fail "pg_dump завершился с ошибкой — бэкап БД НЕ создан."
  exit 1
fi

# -----------------------------------------------------------------------------
# Шаг 2. Зеркало медиа (mc mirror), gracefully при недоступности
# -----------------------------------------------------------------------------
step "Шаг 2/3. Зеркалирую медиа из MinIO/S3"

S3_BUCKET_VAL="${S3_BUCKET:-}"
S3_ENDPOINT_VAL="${S3_ENDPOINT:-}"
S3_ACCESS_KEY_VAL="${S3_ACCESS_KEY:-}"
S3_SECRET_KEY_VAL="${S3_SECRET_KEY:-}"

# mc — MinIO Client; временный alias (имя см. в MC_ALIAS ниже) прописываем в
# локальный конфиг и удаляем по выходу. Имя alias не магазино-специфично.
MC_ALIAS="adminbackup"
cleanup_mc() {
  if command -v mc >/dev/null 2>&1; then
    mc alias rm "${MC_ALIAS}" >/dev/null 2>&1 || true
  fi
}

S3_CONFIGURED=0
if [ -n "${S3_ENDPOINT_VAL}" ] && [ -n "${S3_BUCKET_VAL}" ] && \
   [ -n "${S3_ACCESS_KEY_VAL}" ] && [ -n "${S3_SECRET_KEY_VAL}" ]; then
  S3_CONFIGURED=1
fi

if ! command -v mc >/dev/null 2>&1; then
  # Заданный S3 = медиа есть, и его надо бэкапить. Отсутствие mc в этом случае —
  # не «особенность dev», а тихий отказ бэкапа: дамп БД содержит лишь КЛЮЧИ
  # файлов, сами изображения в него не попадают. Живой случай 15–29.07.2026:
  # закачка mc сорвалась по таймауту, и 15 прогонов подряд рапортовали
  # «Бэкап готов», пока 819 МБ фотографий оставались без единой копии.
  if [ "${S3_CONFIGURED}" -eq 1 ]; then
    fail "MinIO Client (mc) не найден, а S3 настроен — медиа НЕ сохранено."
    fail "Дамп БД содержит только ключи файлов: потеря бакета = потеря всех фото."
    fail "Установите mc в контейнер backup и повторите бэкап."
    exit 1
  fi
  warn "MinIO Client (mc) не найден, S3 не настроен — медиа нет, пропускаю."
elif [ "${S3_CONFIGURED}" -eq 0 ]; then
  warn "S3_ENDPOINT/S3_BUCKET/ключи заданы не полностью — пропускаю медиа."
else
  trap cleanup_mc EXIT
  if ! mc alias set "${MC_ALIAS}" "${S3_ENDPOINT_VAL}" \
         "${S3_ACCESS_KEY_VAL}" "${S3_SECRET_KEY_VAL}" >/dev/null 2>&1; then
    fail "Не удалось подключиться к S3 (${S3_ENDPOINT_VAL}) — медиа НЕ сохранено."
    cleanup_mc
    exit 1
  elif ! mc ls "${MC_ALIAS}/${S3_BUCKET_VAL}" >/dev/null 2>&1; then
    # Пустой бакет от недоступного не отличить по коду `mc ls`, поэтому
    # различаем явно: пустой — законный повод пропустить, недоступный — отказ.
    if mc stat "${MC_ALIAS}/${S3_BUCKET_VAL}" >/dev/null 2>&1; then
      warn "Бакет ${S3_BUCKET_VAL} пуст — медиа нечего сохранять."
    else
      fail "Бакет ${S3_BUCKET_VAL} недоступен — медиа НЕ сохранено."
      cleanup_mc
      exit 1
    fi
  else
    # --overwrite/--remove держат зеркало в актуальном состоянии;
    # медиа аддитивно — это безопасно (см. порядок §6.2).
    if mc mirror --overwrite "${MC_ALIAS}/${S3_BUCKET_VAL}" "${MEDIA_DIR}/"; then
      ok "Медиа зазеркалировано в ${MEDIA_DIR}/"
    else
      # Готовый дамп БД не делает бэкап состоявшимся: без фотографий магазин
      # не восстановить. Падаем, чтобы cron-прогон отметился как неуспешный.
      fail "mc mirror завершился с ошибкой — медиа НЕ обновлено, бэкап неполный."
      cleanup_mc
      exit 1
    fi
  fi
  cleanup_mc
  trap - EXIT
fi

# -----------------------------------------------------------------------------
# Шаг 3. Ретенция — удаляем файлы старше BACKUP_RETENTION_DAYS
# -----------------------------------------------------------------------------
step "Шаг 3/3. Ретенция: удаляю бэкапы старше ${RETENTION_DAYS} дн."

if printf '%s' "${RETENTION_DAYS}" | grep -qE '^[0-9]+$' && [ "${RETENTION_DAYS}" -gt 0 ]; then
  # Дампы БД старше N дней.
  DB_PRUNED="$(find "${DB_DIR}" -type f -name '*.dump' -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')"
  ok "Старых дампов БД удалено: ${DB_PRUNED}"

  # Старые файлы зеркала медиа (зеркало переписывается, но осиротевшие старые
  # файлы тоже подчищаем по mtime), затем пустые каталоги.
  MEDIA_PRUNED="$(find "${MEDIA_DIR}" -type f -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')"
  find "${MEDIA_DIR}" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  ok "Старых файлов медиа удалено: ${MEDIA_PRUNED}"
else
  warn "BACKUP_RETENTION_DAYS='${RETENTION_DAYS}' не положительное целое — ретенция пропущена."
fi

printf "\n${GREEN}${BOLD}Бэкап готов.${NC} БД: %s\n" "${DUMP_FILE}"
exit 0
