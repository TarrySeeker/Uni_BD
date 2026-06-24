#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — обновление магазина без простоев (Этап 6, пакет 6.4; §6.4, ADR-015)
# =============================================================================
# Процедура near-zero-downtime для single-VPS (ADR-003: «1 магазин = 1 VPS»).
# k8s-rolling недоступен, но near-zero-downtime достигается так:
#   собрать НОВЫЙ образ заранее → обязательный бэкап → накатить ТОЛЬКО-аддитивные
#   миграции (старый код совместим с новой схемой) → быстро пересоздать `app` с
#   health-gate → при провале АВТОМАТИЧЕСКИЙ ОТКАТ на прежнюю версию.
#
# Шаги (см. §6.4 «Файлы → update.sh»):
#   1. Зафиксировать текущую версию (git rev-parse HEAD) — точка отката.
#   2. git pull (или checkout нового тега UPDATE_REF) — притянуть новый код.
#   3. docker compose build app — новый образ (старый контейнер ещё работает).
#   4. scripts/backup.sh — ОБЯЗАТЕЛЬНЫЙ бэкап перед миграциями (страховка данных).
#   5. scripts/check-migrations.sh — стоп, если новые миграции НЕ аддитивны.
#   6. Накат миграций (init-shop.sh — идемпотентен; накатывает только новое).
#   7. docker compose up -d app — пересоздать app новым образом (Docker ждёт
#      healthcheck).
#   8. Health-gate: curl /api/health?deep=1 с ретраями. Провал → ОТКАТ: вернуть
#      прежний git-ref + ПРЕЖНИЙ ОБРАЗ-СНИМОК без пересборки (пункт a), алерт.
#   9. Лог результата (версия до/после, длительность) в JSON-совместимом виде.
#
# Идемпотентность: повторный запуск безопасен (git pull/up -d/init-shop —
# идемпотентны; бэкап создаёт новый файл).
#
# Настройка через env (.env подхватывается автоматически, если рядом):
#   COMPOSE                 — команда compose (по умолчанию «docker compose»);
#   APP_IMAGE               — имя образа app (как в docker-compose.yml; дефолт admik-app:current);
#                             для честного отката снимок тегируется как <name>:rollback;
#   UPDATE_REF              — git-ref/тег для деплоя (по умолчанию git pull текущей ветки);
#   UPDATE_SKIP_BACKUP      — true → пропустить бэкап (НЕ рекомендуется; для тестов);
#   HEALTHCHECK_URL         — базовый URL health (из W3; по умолчанию
#                             http://localhost/api/health); deep-режим добавляется автоматически;
#   UPDATE_HEALTH_RETRIES   — число попыток health-gate (по умолчанию 30);
#   UPDATE_HEALTH_TIMEOUT   — пауза между попытками в секундах (по умолчанию 2);
#   ALERT_WEBHOOK_URL       — webhook для алерта при откате (из W3; пусто → только лог).
#
# Код возврата: 0 — обновление успешно (health зелёный); ≠0 — провал/откат.
#
# ОПЦИЯ-РАСШИРЕНИЕ (two-slot, честный zero-downtime): вместо пересоздания `app`
# поднять `app2` на новом образе, дождаться healthy, переключить Caddy
# reverse_proxy на app2 и погасить старый. Усложняет конфиг (доп. сервис + правка
# Caddyfile), для ИМ-админки секундный простой приемлем → НЕ дефолт. Здесь
# реализован пересоздающий вариант; two-slot документируется в docs/09.
#
# Запуск:
#   ./scripts/update.sh
#   UPDATE_REF=v1.2.3 ./scripts/update.sh
# =============================================================================

set -euo pipefail

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
cd "${PROJECT_ROOT}"

# Подхватываем .env (для COMPOSE/HEALTHCHECK_URL/ALERT_WEBHOOK_URL/UPDATE_*).
if [ -f "${PROJECT_ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${PROJECT_ROOT}/.env"
  set +a
fi

# -----------------------------------------------------------------------------
# Параметры (всё из env, безопасные дефолты).
# -----------------------------------------------------------------------------
COMPOSE="${COMPOSE:-docker compose}"
UPDATE_REF="${UPDATE_REF:-}"
HEALTH_URL_BASE="${HEALTHCHECK_URL:-http://localhost/api/health}"
HEALTH_RETRIES="${UPDATE_HEALTH_RETRIES:-30}"
HEALTH_DELAY="${UPDATE_HEALTH_TIMEOUT:-2}"
SKIP_BACKUP_VALUE="$(printf '%s' "${UPDATE_SKIP_BACKUP:-}" | tr '[:upper:]' '[:lower:]')"

# Образ приложения (имя из docker-compose.yml: image: ${APP_IMAGE:-admik-app:current})
# и его СНИМОК для честного отката (бэклог Этапа 6, пункт a). Перед сборкой нового
# образа текущий тегируется как ROLLBACK_IMAGE; при провале откат ВОЗВРАЩАЕТ его
# без пересборки (быстро и детерминированно), а не пересобирает старый код.
APP_IMAGE="${APP_IMAGE:-admik-app:current}"
ROLLBACK_IMAGE="${APP_IMAGE%:*}:rollback"
HAVE_ROLLBACK_IMAGE=false

# Deep-режим health-gate: добавляем ?deep=1 (учитываем уже существующий query).
case "${HEALTH_URL_BASE}" in
  *\?*) HEALTH_URL="${HEALTH_URL_BASE}&deep=1" ;;
  *)    HEALTH_URL="${HEALTH_URL_BASE}?deep=1" ;;
esac

START_EPOCH="$(date -u +%s)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf "${BOLD}=== Admik · обновление магазина (near-zero-downtime) ===${NC}\n\n"

# -----------------------------------------------------------------------------
# emit_result — JSON-совместимый лог результата в stdout (§6.4 шаг 9).
# -----------------------------------------------------------------------------
emit_result() {
  local result="$1" old_ref="$2" new_ref="$3" message="$4"
  local end_epoch duration end_iso
  end_epoch="$(date -u +%s)"
  duration=$(( end_epoch - START_EPOCH ))
  end_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"event":"update","result":"%s","version_before":"%s","version_after":"%s","started_at":"%s","finished_at":"%s","duration_sec":%s,"message":"%s"}\n' \
    "${result}" "${old_ref}" "${new_ref}" "${START_ISO}" "${end_iso}" "${duration}" "${message}"
}

# -----------------------------------------------------------------------------
# send_alert — отправить алерт в ALERT_WEBHOOK_URL (graceful: пусто → только лог).
# -----------------------------------------------------------------------------
send_alert() {
  local text="$1"
  if [ -z "${ALERT_WEBHOOK_URL:-}" ]; then
    warn "ALERT_WEBHOOK_URL не задан — алерт только в лог: ${text}"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl не найден — алерт не отправлен: ${text}"
    return 0
  fi
  # JSON-payload, совместимый с Telegram (text) / Slack (text).
  local payload
  payload="$(printf '{"text":"[Admik update] %s"}' "${text}")"
  if curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
       -d "${payload}" "${ALERT_WEBHOOK_URL}" >/dev/null 2>&1; then
    ok "Алерт отправлен в webhook."
  else
    warn "Не удалось отправить алерт в webhook (продолжаю)."
  fi
}

# -----------------------------------------------------------------------------
# health_gate — curl HEALTH_URL с ретраями. 0 — здоров (HTTP 200), ≠0 — нет.
# -----------------------------------------------------------------------------
health_gate() {
  local attempt=1 status last=""
  if ! command -v curl >/dev/null 2>&1; then
    fail "curl не найден — health-gate невозможен."
    return 1
  fi
  while [ "${attempt}" -le "${HEALTH_RETRIES}" ]; do
    if status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "${HEALTH_URL}" 2>/dev/null)"; then
      if [ "${status}" = "200" ]; then
        ok "Health-gate: HTTP 200 (deep) — приложение готово."
        return 0
      fi
      last="HTTP ${status}"
    else
      last="нет ответа"
    fi
    if [ "${attempt}" -lt "${HEALTH_RETRIES}" ]; then
      printf "  ... health %s/%s: %s — повтор через %sс\n" \
        "${attempt}" "${HEALTH_RETRIES}" "${last}" "${HEALTH_DELAY}"
      sleep "${HEALTH_DELAY}"
    fi
    attempt=$((attempt + 1))
  done
  fail "Health-gate провален за ${HEALTH_RETRIES} попыток (последнее: ${last})."
  return 1
}

# -----------------------------------------------------------------------------
# snapshot_current_image — тегирует текущий (рабочий) образ как ROLLBACK_IMAGE.
# Снимок делается ДО сборки нового образа, чтобы откат вернул именно прежний
# артефакт без пересборки. Если docker/образа нет — откат деградирует до
# пересборки (HAVE_ROLLBACK_IMAGE остаётся false), не прерывая обновление.
# -----------------------------------------------------------------------------
snapshot_current_image() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker CLI не найден — снимок образа для отката недоступен (откат будет пересборкой)."
    return 0
  fi
  if ! docker image inspect "${APP_IMAGE}" >/dev/null 2>&1; then
    warn "Образ ${APP_IMAGE} не найден (первый деплой?) — откат будет пересборкой."
    return 0
  fi
  if docker tag "${APP_IMAGE}" "${ROLLBACK_IMAGE}"; then
    HAVE_ROLLBACK_IMAGE=true
    ok "Снимок текущего образа для отката: ${ROLLBACK_IMAGE}"
  else
    warn "Не удалось затегировать ${ROLLBACK_IMAGE} — откат будет пересборкой."
  fi
}

# -----------------------------------------------------------------------------
# rollback — откат на прежний git-ref + ВОЗВРАТ прежнего ОБРАЗА без пересборки
# (честный откат, пункт a). Фолбэк (нет снимка/docker) — пересборка старого кода.
# -----------------------------------------------------------------------------
rollback() {
  local old_ref="$1"
  fail "ОТКАТ на прежнюю версию ${old_ref}"
  # Вернуть код/конфиги на зафиксированный коммит (compose-файлы, скрипты, миграции).
  if git checkout --quiet "${old_ref}" 2>/dev/null; then
    ok "git checkout ${old_ref}"
  else
    fail "Не удалось git checkout ${old_ref} — откат кода вручную!"
  fi
  # Честный откат: вернуть прежний ОБРАЗ (retag снимка → имя образа) и пересоздать
  # app без пересборки. Так возвращается ровно тот артефакт, что работал до выката.
  if [ "${HAVE_ROLLBACK_IMAGE}" = true ] && command -v docker >/dev/null 2>&1; then
    if docker tag "${ROLLBACK_IMAGE}" "${APP_IMAGE}" \
       && ${COMPOSE} up -d --no-build --force-recreate app; then
      ok "Возвращён прежний образ ${APP_IMAGE} (без пересборки)."
      return 0
    fi
    warn "Возврат образа не удался — деградирую до пересборки старого кода."
  fi
  # Фолбэк: пересобрать старый образ из кода и поднять (Docker дождётся healthcheck).
  if ${COMPOSE} build app && ${COMPOSE} up -d app; then
    ok "Старый образ app пересобран и поднят."
  else
    fail "Не удалось поднять старый образ — требуется ручное вмешательство!"
  fi
}

# =============================================================================
# Шаг 1. Зафиксировать текущую версию (точка отката).
# =============================================================================
step "Шаг 1/8. Фиксирую текущую версию (для отката)"
if ! command -v git >/dev/null 2>&1; then
  fail "git не найден — обновление невозможно."
  exit 1
fi
OLD_REF="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
ok "Текущая версия: ${OLD_REF}"

# =============================================================================
# Шаг 2. Притянуть новый код (git pull или checkout тега).
# =============================================================================
step "Шаг 2/8. Притягиваю новый код"
if [ -n "${UPDATE_REF}" ]; then
  if ! git fetch --tags --quiet; then
    fail "git fetch не удался."; exit 1
  fi
  if ! git checkout --quiet "${UPDATE_REF}"; then
    fail "git checkout ${UPDATE_REF} не удался."; exit 1
  fi
  ok "Переключился на ref: ${UPDATE_REF}"
else
  if ! git pull --ff-only; then
    fail "git pull не удался (нужен fast-forward). Разрешите конфликты вручную."; exit 1
  fi
  ok "git pull выполнен"
fi
NEW_REF="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"

if [ "${NEW_REF}" = "${OLD_REF}" ]; then
  ok "Версия не изменилась (${NEW_REF}) — обновлять нечего."
  emit_result "noop" "${OLD_REF}" "${NEW_REF}" "no changes"
  exit 0
fi

# =============================================================================
# Шаг 3. Собрать новый образ (старый контейнер ещё работает).
# =============================================================================
step "Шаг 3/8. Собираю новый образ app"
# Снимок текущего образа ДО сборки — артефакт для честного отката (пункт a).
snapshot_current_image
if ! ${COMPOSE} build app; then
  fail "Сборка нового образа провалилась — откатываю код."
  rollback "${OLD_REF}"
  emit_result "failed" "${OLD_REF}" "${NEW_REF}" "build failed"
  exit 1
fi
ok "Новый образ app собран"

# =============================================================================
# Шаг 4. Обязательный бэкап перед миграциями.
# =============================================================================
step "Шаг 4/8. Обязательный бэкап перед миграциями"
case "${SKIP_BACKUP_VALUE}" in
  true|1|yes)
    warn "UPDATE_SKIP_BACKUP включён — бэкап ПРОПУЩЕН (рискованно!)."
    ;;
  *)
    if ! "${SCRIPT_DIR}/backup.sh"; then
      fail "Бэкап провалился — обновление ОСТАНОВЛЕНО до миграций (данные не тронуты)."
      git checkout --quiet "${OLD_REF}" 2>/dev/null || true
      emit_result "failed" "${OLD_REF}" "${NEW_REF}" "backup failed"
      exit 1
    fi
    ok "Бэкап создан"
    ;;
esac

# =============================================================================
# Шаг 5. Линтер аддитивности миграций — стоп, если не аддитивны.
# =============================================================================
step "Шаг 5/8. Проверяю аддитивность миграций (check-migrations.sh)"
if ! "${SCRIPT_DIR}/check-migrations.sh"; then
  fail "Миграции НЕ аддитивны — выкат остановлен (откат кода, данные не тронуты)."
  git checkout --quiet "${OLD_REF}" 2>/dev/null || true
  emit_result "failed" "${OLD_REF}" "${NEW_REF}" "non-additive migrations"
  exit 1
fi
ok "Миграции аддитивны"

# =============================================================================
# Шаг 6. Накат миграций (init-shop.sh идемпотентен; схема аддитивна →
# старый контейнер продолжает работать).
# =============================================================================
step "Шаг 6/8. Накатываю миграции (init-shop.sh)"
if ! ${COMPOSE} exec -T app /app/scripts/init-shop.sh; then
  fail "Накат миграций провалился."
  send_alert "миграции упали при обновлении ${OLD_REF} → ${NEW_REF}; данные в бэкапе шага 4"
  rollback "${OLD_REF}"
  emit_result "failed" "${OLD_REF}" "${NEW_REF}" "migrations failed"
  exit 1
fi
ok "Миграции накатаны"

# =============================================================================
# Шаг 7. Пересоздать app новым образом (Docker дождётся healthcheck).
# =============================================================================
step "Шаг 7/8. Пересоздаю app новым образом"
if ! ${COMPOSE} up -d app; then
  fail "Не удалось поднять новый app."
  send_alert "up -d нового app упал при обновлении ${OLD_REF} → ${NEW_REF}"
  rollback "${OLD_REF}"
  emit_result "failed" "${OLD_REF}" "${NEW_REF}" "up -d failed"
  exit 1
fi
ok "Новый app поднят"

# =============================================================================
# Шаг 8. Health-gate: deep-check с ретраями; провал → откат.
# =============================================================================
step "Шаг 8/8. Health-gate: ${HEALTH_URL}"
if health_gate; then
  ok "Health-gate зелёный — обновление успешно."
  emit_result "success" "${OLD_REF}" "${NEW_REF}" "ok"
  printf "\n${GREEN}${BOLD}Обновление завершено.${NC} %s → %s\n" "${OLD_REF}" "${NEW_REF}"
  exit 0
else
  fail "Health-gate провален — выполняю ОТКАТ."
  send_alert "health-gate провален при обновлении ${OLD_REF} → ${NEW_REF}; откатываюсь"
  rollback "${OLD_REF}"
  # После отката убедимся, что старый снова жив (best-effort).
  if health_gate; then
    ok "После отката приложение здорово."
  else
    fail "После отката health всё ещё красный — РУЧНОЕ вмешательство!"
  fi
  emit_result "rolled_back" "${OLD_REF}" "${NEW_REF}" "health-gate failed, rolled back"
  exit 1
fi
