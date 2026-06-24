#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — smoke-проверка запущенного стека (Этап 6, пакет 6.1)
# =============================================================================
# Этот скрипт подтверждает, что магазин не просто «поднялся», а реально
# отвечает на ключевых публичных адресах. Его запускают ПОСЛЕ
# `docker compose up -d` и `init-shop.sh` (см. scripts/deploy.sh, `make smoke`).
#
# Что проверяется (каждый адрес — отдельная строка OK/FAIL):
#   • GET /api/health                    → HTTP 200 и тело содержит "status":"ok"
#                                          (приложение живо — liveness);
#   • GET /api/storefront/v1/categories  → HTTP 200 (read-каталог отдаётся;
#                                          ловит «забыли init-shop» — без таблиц
#                                          был бы 500);
#   • GET /api/storefront/v1/products    → HTTP 200 (каталог товаров жив);
#   • GET /admin/login                   → HTTP 200 (админка отдаётся).
#
# Эти адреса публичны и НЕ требуют боевых ключей (mock-режимы СДЭК/Storefront/S3
# уже есть), поэтому smoke зелёный на чистом магазине (ADR-003, инвариант §4.4).
#
# Настройка через env (.env подхватывается автоматически, если рядом):
#   SMOKE_BASE_URL    — база URL стенда (по умолчанию http://localhost);
#   SMOKE_RETRIES     — число попыток на каждый адрес (по умолчанию 30);
#   SMOKE_RETRY_DELAY — пауза между попытками в секундах (по умолчанию 2).
# Дефолты дают ≈60с ожидания — стек поднимается не мгновенно.
#
# Код возврата: 0 — все проверки прошли; ≠0 — хотя бы одна провалилась.
#
# Запуск:
#   ./scripts/smoke.sh
#   SMOKE_BASE_URL=https://example.com ./scripts/smoke.sh
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
pass()  { printf "${GREEN}  ✔${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  ⚠${NC} %s\n" "$1"; }
fail()  { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

# Безопасная загрузка KEY=VALUE из .env в окружение БЕЗ shell-eval: значение
# берётся дословно (всё после первого '='), без word-splitting и глоббинга — как
# env_file в docker compose. Устойчиво к значениям с пробелами/звёздочками
# (`BACKUP_CRON=0 3 * * *`, `SHOP_NAME=Мой магазин`), которые ломали `. .env`.
load_env_file() {
  local file="$1" line key value
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "${line}" ] && continue
    case "${line}" in \#*) continue ;; esac
    case "${line}" in export\ *) line="${line#export }" ;; esac
    case "${line}" in *=*) : ;; *) continue ;; esac
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
# чтобы скрипт работал из любой директории и нашёл .env.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Подхватываем .env, если он есть рядом (для SMOKE_BASE_URL и т.п.).
# Не обязателен: дефолты ниже работают и без .env. Загружаем БЕЗ shell-eval
# (load_env_file), чтобы значения с пробелами/звёздочками в .env не ломали smoke.
if [ -f "${PROJECT_ROOT}/.env" ]; then
  load_env_file "${PROJECT_ROOT}/.env"
fi

# -----------------------------------------------------------------------------
# Зависимость: curl
# -----------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  fail "Утилита curl не найдена. Установите её, например:"
  warn "    Debian/Ubuntu: sudo apt-get install -y curl"
  warn "    Alpine:        apk add curl"
  exit 1
fi

# -----------------------------------------------------------------------------
# Параметры
# -----------------------------------------------------------------------------
# Убираем хвостовой слэш, чтобы не получить двойной // в адресах.
BASE_URL="${SMOKE_BASE_URL:-http://localhost}"
BASE_URL="${BASE_URL%/}"
RETRIES="${SMOKE_RETRIES:-30}"
RETRY_DELAY="${SMOKE_RETRY_DELAY:-2}"

printf "${BOLD}=== Admik · smoke-проверка ===${NC}\n"
printf "База: %s · попыток на адрес: %s · пауза: %sс\n\n" \
  "${BASE_URL}" "${RETRIES}" "${RETRY_DELAY}"

# Счётчик провалов (общий exit-код).
FAILURES=0

# -----------------------------------------------------------------------------
# check <человекочитаемое имя> <путь> [подстрока-в-теле]
# -----------------------------------------------------------------------------
# Дёргает BASE_URL + путь до RETRIES раз. Успех = HTTP 200 И (если задана
# подстрока) тело содержит её. Печатает одну строку OK/FAIL. При провале
# увеличивает FAILURES (не выходит сразу — чтобы прогнать все проверки).
check() {
  local name="$1" path="$2" needle="${3:-}"
  local url="${BASE_URL}${path}"
  local attempt=1 status="" body="" last_err=""

  step "Проверяю ${name} (${path})"

  while [ "${attempt}" -le "${RETRIES}" ]; do
    # Тело в отдельный файл, HTTP-код — в stdout curl. -s тихо, -m таймаут.
    local body_file
    body_file="$(mktemp)"
    if status="$(curl -sS -m 10 -o "${body_file}" -w '%{http_code}' "${url}" 2>/dev/null)"; then
      body="$(cat "${body_file}")"
      rm -f "${body_file}"
      if [ "${status}" = "200" ]; then
        if [ -z "${needle}" ] || printf '%s' "${body}" | grep -qF "${needle}"; then
          pass "${name}: HTTP 200${needle:+ + тело содержит ${needle}}"
          return 0
        fi
        last_err="HTTP 200, но тело не содержит «${needle}»"
      else
        last_err="HTTP ${status}"
      fi
    else
      rm -f "${body_file}"
      last_err="нет ответа (соединение не установлено)"
    fi

    if [ "${attempt}" -lt "${RETRIES}" ]; then
      printf "  ... попытка %s/%s: %s — повтор через %sс\n" \
        "${attempt}" "${RETRIES}" "${last_err}" "${RETRY_DELAY}"
      sleep "${RETRY_DELAY}"
    fi
    attempt=$((attempt + 1))
  done

  fail "${name}: ${last_err} (после ${RETRIES} попыток) — ${url}"
  FAILURES=$((FAILURES + 1))
  return 0
}

# -----------------------------------------------------------------------------
# Набор проверок
# -----------------------------------------------------------------------------
check "health (liveness)"  "/api/health"                     '"status":"ok"'
check "storefront/categories" "/api/storefront/v1/categories"
check "storefront/products"   "/api/storefront/v1/products"
check "admin/login"           "/admin/login"

# -----------------------------------------------------------------------------
# Итог
# -----------------------------------------------------------------------------
printf "\n"
if [ "${FAILURES}" -eq 0 ]; then
  printf "${GREEN}${BOLD}Smoke OK${NC} — все проверки прошли.\n"
  exit 0
fi

fail "Smoke FAILED — провалено проверок: ${FAILURES}."
warn "Подсказки: стек поднят? (docker compose ps) · выполнен init-shop?"
warn "           верный ли SMOKE_BASE_URL=${BASE_URL}?"
exit 1
