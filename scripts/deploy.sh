#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — единый copy-paste-деплой (Этап 6, пакет 6.1)
# =============================================================================
# Тонкая ИДЕМПОТЕНТНАЯ обёртка вокруг существующей последовательности развёртывания
# (docs/02): поднять стек → инициализировать магазин → подтвердить готовность.
# Повторный запуск безопасен (up -d не пересоздаёт здоровое, init-shop идемпотентен).
#
# Шаги:
#   1. Проверить наличие .env (если нет — подсказать `cp .env.example .env`, выйти ≠0).
#   2. docker compose up -d --build — собрать образ и поднять стек.
#   3. Инициализация магазина внутри контейнера app:
#        docker compose exec -T app /app/scripts/init-shop.sh
#      (внутри образа скрипт лежит по /app/scripts — см. Dockerfile/standalone;
#       -T отключает псевдо-TTY, чтобы работать в неинтерактивном окружении).
#   4. scripts/smoke.sh — подтверждение готовности (HTTP-проверки эндпоинтов).
#
# Запуск:
#   ./scripts/deploy.sh
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

# Безопасная загрузка KEY=VALUE из .env в окружение БЕЗ shell-eval (как в
# init-shop.sh/smoke.sh): значение берётся дословно (всё после первого '='), без
# word-splitting и глоббинга. Нужна, чтобы прочитать S3_BUCKET для шага создания
# бакета MinIO (см. ниже). Устойчиво к значениям с пробелами/звёздочками.
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

# Корень проекта (работаем из него, чтобы compose нашёл docker-compose.yml/.env).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

printf "${BOLD}=== Admik · деплой ===${NC}\n\n"

# -----------------------------------------------------------------------------
# Зависимость: docker compose
# -----------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker не найден. Установите Docker (см. docs/09)."
  exit 1
fi
# Поддерживаем как `docker compose` (плагин), так и docker без него.
if ! docker compose version >/dev/null 2>&1; then
  fail "Плагин 'docker compose' недоступен. Установите Docker Compose v2."
  exit 1
fi

# -----------------------------------------------------------------------------
# Шаг 1. Проверка .env
# -----------------------------------------------------------------------------
step "Шаг 1/5. Проверяю конфигурацию (.env)"
if [ ! -f "${PROJECT_ROOT}/.env" ]; then
  fail "Файл .env не найден."
  warn "Создайте его из шаблона и заполните значения:"
  warn "    cp .env.example .env"
  exit 1
fi
# Подхватываем .env в окружение скрипта (БЕЗ shell-eval) — нужно для S3_BUCKET
# на шаге создания бакета MinIO. compose свои переменные читает из .env сам.
load_env_file "${PROJECT_ROOT}/.env"
ok ".env на месте"

# -----------------------------------------------------------------------------
# Шаг 2. Поднять стек
# -----------------------------------------------------------------------------
step "Шаг 2/5. Поднимаю стек (docker compose up -d --build)"
docker compose up -d --build
ok "Стек запущен (контейнеры создаются/обновляются)"

# -----------------------------------------------------------------------------
# Шаг 3. Бакет MinIO для медиа (идемпотентно)
# -----------------------------------------------------------------------------
# Загрузка медиа требует, чтобы в MinIO существовал бакет ${S3_BUCKET} (дефолт
# admik-media) с публичным чтением — иначе deep-health показывает s3 error, а
# картинки товаров не отдаются. Создаём его ВНУТРИ контейнера minio через mc:
#   • алиас `local` задаётся ROOT-кредами (MINIO_ROOT_USER/PASSWORD уже в env
#     контейнера minio) — без них mc отвечает Access Denied;
#   • mc mb --ignore-existing — идемпотентно: повторный деплой не падает, если
#     бакет уже есть;
#   • mc anonymous set download — публичное ЧТЕНИЕ объектов (запись закрыта).
# S3_BUCKET в env контейнера minio НЕ задан, поэтому пробрасываем его сюда явно
# (-e) из окружения скрипта (загружено из .env выше; дефолт admik-media).
# `</dev/null` обязателен: `docker compose exec -T` иначе «съест» stdin deploy.sh.
# Шаг не критичен для подъёма стека — при сбое предупреждаем и продолжаем.
step "Шаг 3/5. Создаю бакет MinIO для медиа (идемпотентно)"
S3_BUCKET_VALUE="${S3_BUCKET:-admik-media}"
if docker compose exec -T -e "S3_BUCKET=${S3_BUCKET_VALUE}" minio sh -c \
     'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && mc mb --ignore-existing "local/$S3_BUCKET" && mc anonymous set download "local/$S3_BUCKET"' \
     </dev/null; then
  ok "Бакет '${S3_BUCKET_VALUE}' готов (создан/уже был), публичное чтение включено"
else
  warn "Не удалось настроить бакет MinIO '${S3_BUCKET_VALUE}' — проверьте сервис minio (docker compose logs minio)."
  warn "Загрузка/отдача медиа может не работать, пока бакет не создан."
fi

# -----------------------------------------------------------------------------
# Шаг 4. Инициализация магазина (внутри контейнера app)
# -----------------------------------------------------------------------------
# init-shop сам ждёт готовности БД (pg_isready, до ~2 мин), накатывает миграции
# и seed. Идемпотентен — повторный деплой не портит данные.
step "Шаг 4/5. Инициализирую магазин (init-shop внутри контейнера app)"
docker compose exec -T app /app/scripts/init-shop.sh
ok "Инициализация завершена"

# Регресс-гард нативного sharp/libvips в образе (ловит ERR_DLOPEN, из-за которого
# падали экшены каталога и storefront brands/products/pages — см. sharp-selfcheck.mjs).
step "Проверяю нативный sharp/libvips внутри образа"
docker compose exec -T app node /app/scripts/sharp-selfcheck.mjs

# -----------------------------------------------------------------------------
# Шаг 5. Smoke — подтверждение готовности
# -----------------------------------------------------------------------------
step "Шаг 5/5. Smoke-проверка готовности"
"${SCRIPT_DIR}/smoke.sh"

printf "\n${GREEN}${BOLD}Деплой завершён.${NC} Магазин поднят, инициализирован и проверен.\n"
