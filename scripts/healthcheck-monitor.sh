#!/usr/bin/env bash
# =============================================================================
# Admik — внешний монитор доступности + ресурсов (Этап 6, пакет 6.3; ADR-015)
# =============================================================================
# Лёгкий self-hosted монитор без внешних SaaS (§6.3.2/6.3.3):
#   • периодически (или разово при ручном запуске) дёргает /api/health;
#   • при N подряд неудачах шлёт алерт на ALERT_WEBHOOK_URL (Telegram/Slack);
#   • проверяет свободное место на диске (алерт при заполнении > порога —
#     критично из-за бэкапов и логов).
# При пустом ALERT_WEBHOOK_URL алерты деградируют в лог (скрипт НЕ падает —
# инвариант §4.4 «mock-режимы не мешают эксплуатации»).
#
# ЗАПУСК. Скрипт делает ОДИН цикл проверок и выходит — его дёргает планировщик
# (системный cron хоста или cron-сервис compose), например каждые 2 минуты:
#   */2 * * * * /app/scripts/healthcheck-monitor.sh >> /var/log/admik-monitor.log 2>&1
# Счётчик подряд-неудач хранится в файле STATE_FILE между запусками.
#
# Настройка через env (.env подхватывается, если рядом):
#   HEALTHCHECK_URL              — адрес проверки (по умолчанию http://localhost/api/health);
#   HEALTHCHECK_FAILS_THRESHOLD  — сколько подряд неудач до алерта (по умолчанию 3);
#   ALERT_WEBHOOK_URL            — webhook для алертов (пусто = только лог);
#   HEALTHCHECK_DISK_THRESHOLD   — порог заполнения диска в % (по умолчанию 90);
#   HEALTHCHECK_DISK_PATH        — какой раздел проверять (по умолчанию /);
#   HEALTHCHECK_STATE_FILE       — где хранить счётчик (по умолчанию во временном каталоге).
#
# Код возврата: 0 — всё в норме (или алерт корректно отправлен/залогирован);
#               ≠0 — внутренняя ошибка скрипта (не «сервис недоступен» — это штатно).
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Корень проекта и подхват .env (для HEALTHCHECK_URL/ALERT_WEBHOOK_URL и т.п.).
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ -f "${PROJECT_ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${PROJECT_ROOT}/.env"
  set +a
fi

# -----------------------------------------------------------------------------
# Параметры (env с дефолтами).
# -----------------------------------------------------------------------------
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://localhost/api/health}"
FAILS_THRESHOLD="${HEALTHCHECK_FAILS_THRESHOLD:-3}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
DISK_THRESHOLD="${HEALTHCHECK_DISK_THRESHOLD:-90}"
DISK_PATH="${HEALTHCHECK_DISK_PATH:-/}"
STATE_FILE="${HEALTHCHECK_STATE_FILE:-${TMPDIR:-/tmp}/admik-healthcheck.state}"

# -----------------------------------------------------------------------------
# Структурный JSON-лог в stdout (одна строка = одно событие; единый формат с
# приложением, §6.3.1). Аргументы: level msg [key=value ...].
# -----------------------------------------------------------------------------
log_event() {
  local level="$1" msg="$2"
  shift 2
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Экранируем кавычки/бэкслеши в сообщении для валидного JSON.
  local esc_msg="${msg//\\/\\\\}"
  esc_msg="${esc_msg//\"/\\\"}"
  local extra=""
  local pair key val
  for pair in "$@"; do
    key="${pair%%=*}"
    val="${pair#*=}"
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    extra="${extra},\"${key}\":\"${val}\""
  done
  printf '{"ts":"%s","level":"%s","module":"healthcheck-monitor","msg":"%s"%s}\n' \
    "${ts}" "${level}" "${esc_msg}" "${extra}"
}

# -----------------------------------------------------------------------------
# Отправка алерта: на ALERT_WEBHOOK_URL (JSON-payload, совместимый с Telegram
# `sendMessage` и Slack incoming webhook — оба принимают поле "text"). При пустом
# URL — только лог (graceful degradation, НЕ падаем). Сбой доставки не валит скрипт.
# -----------------------------------------------------------------------------
send_alert() {
  local text="$1"
  log_event "error" "ALERT: ${text}"

  if [ -z "${ALERT_WEBHOOK_URL}" ]; then
    log_event "warn" "ALERT_WEBHOOK_URL пуст — алерт отправлен только в лог"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    log_event "warn" "curl не найден — алерт не доставлен на webhook"
    return 0
  fi

  # JSON-экранирование текста для payload.
  local esc="${text//\\/\\\\}"
  esc="${esc//\"/\\\"}"
  # Поле "text" понимают и Slack, и Telegram (chat_id задаётся в самом URL).
  local payload="{\"text\":\"[Admik] ${esc}\"}"

  if curl -fsS -m 15 -X POST \
      -H 'Content-Type: application/json' \
      -d "${payload}" \
      "${ALERT_WEBHOOK_URL}" >/dev/null 2>&1; then
    log_event "info" "алерт доставлен на webhook"
  else
    log_event "warn" "не удалось доставить алерт на webhook (доставка не критична)"
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Чтение/запись счётчика подряд-неудач.
# -----------------------------------------------------------------------------
read_fail_count() {
  if [ -f "${STATE_FILE}" ]; then
    local raw
    raw="$(cat "${STATE_FILE}" 2>/dev/null || echo 0)"
    # Только цифры; иначе 0.
    case "${raw}" in
      ''|*[!0-9]*) echo 0 ;;
      *) echo "${raw}" ;;
    esac
  else
    echo 0
  fi
}

write_fail_count() {
  printf '%s' "$1" > "${STATE_FILE}" 2>/dev/null || \
    log_event "warn" "не удалось записать STATE_FILE=${STATE_FILE}"
}

# -----------------------------------------------------------------------------
# Проверка доступности /api/health.
# -----------------------------------------------------------------------------
check_health() {
  if ! command -v curl >/dev/null 2>&1; then
    log_event "error" "curl не найден — проверка доступности невозможна"
    return 1
  fi

  local prev count status
  prev="$(read_fail_count)"

  if status="$(curl -fsS -m 10 -o /dev/null -w '%{http_code}' "${HEALTHCHECK_URL}" 2>/dev/null)" \
      && [ "${status}" = "200" ]; then
    # Успех: сбрасываем счётчик, если он был ненулевым — уведомляем о восстановлении.
    if [ "${prev}" -ge "${FAILS_THRESHOLD}" ]; then
      send_alert "Сервис восстановлен (${HEALTHCHECK_URL} снова отвечает 200)."
    fi
    write_fail_count 0
    log_event "info" "health OK" "url=${HEALTHCHECK_URL}" "http=${status:-200}"
    return 0
  fi

  # Неудача: инкремент счётчика; при достижении порога — алерт.
  count=$((prev + 1))
  write_fail_count "${count}"
  log_event "warn" "health FAIL" \
    "url=${HEALTHCHECK_URL}" "http=${status:-none}" \
    "fails=${count}" "threshold=${FAILS_THRESHOLD}"

  if [ "${count}" -eq "${FAILS_THRESHOLD}" ]; then
    send_alert "Сервис недоступен: ${HEALTHCHECK_URL} (${count} неудач подряд, HTTP=${status:-none})."
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Проверка свободного места на диске.
# -----------------------------------------------------------------------------
check_disk() {
  if ! command -v df >/dev/null 2>&1; then
    log_event "warn" "df не найден — проверка диска пропущена"
    return 0
  fi

  local used
  # Процент использования без знака % (последняя колонка use%).
  used="$(df -P "${DISK_PATH}" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  case "${used}" in
    ''|*[!0-9]*)
      log_event "warn" "не удалось определить заполнение диска" "path=${DISK_PATH}"
      return 0
      ;;
  esac

  log_event "info" "disk usage" "path=${DISK_PATH}" "used_pct=${used}" "threshold=${DISK_THRESHOLD}"
  if [ "${used}" -gt "${DISK_THRESHOLD}" ]; then
    send_alert "Мало места на диске: ${DISK_PATH} занят на ${used}% (порог ${DISK_THRESHOLD}%). Грозит остановкой БД/бэкапов."
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Один цикл проверок.
# -----------------------------------------------------------------------------
log_event "info" "запуск цикла монитора" "url=${HEALTHCHECK_URL}"
check_health
check_disk
log_event "info" "цикл монитора завершён"
exit 0
