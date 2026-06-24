#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — подготовка чистого VPS (Ubuntu 24.04) под деплой (docs/09)
# =============================================================================
# Этот скрипт готовит ЧИСТЫЙ сервер к запуску стека Admik одной командой — для
# человека БЕЗ опыта разработки. Он ИДЕМПОТЕНТЕН: повторный запуск ничего не
# ломает (уже сделанное пропускается).
#
# Что делает:
#   1. Ставит Docker Engine + плагин docker compose (если ещё не стоят).
#   2. Включает swap-файл (по умолчанию 4 ГБ) — страховка от OOM при сборке
#      образов на VPS с малым объёмом RAM. Создаётся только если swap'а ещё нет.
#   3. Настраивает базовый firewall (ufw): разрешает 22 (SSH), 80 и 443 (веб).
#   4. Печатает следующие шаги (clone → .env → make deploy).
#
# Чего НЕ делает: не трогает .env, не хранит секретов, не запускает docker и не
# деплоит. Деплой — отдельный шаг (scripts/deploy.sh / `make deploy`, docs/09).
#
# Настройка через env (необязательно):
#   SWAP_SIZE   — размер swap-файла (по умолчанию 4G; формат как у fallocate);
#   SWAP_FILE   — путь к swap-файлу (по умолчанию /swapfile);
#   SKIP_UFW=1  — не трогать firewall (если им управляет провайдер/облако);
#   SKIP_SWAP=1 — не создавать swap.
#
# Запуск (от root на свежем сервере):
#   ./scripts/server-bootstrap.sh
#   SWAP_SIZE=2G ./scripts/server-bootstrap.sh
# =============================================================================

# Строгий режим: падать при ошибке, обращении к необъявленной переменной и
# ошибке в любой команде конвейера.
set -euo pipefail

# Цвета для наглядного вывода (если терминал поддерживает).
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi

step() { printf "${BOLD}==>${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}  ✔${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}  ⚠${NC} %s\n" "$1"; }
fail() { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

# Параметры (с дефолтами).
SWAP_SIZE="${SWAP_SIZE:-4G}"
SWAP_FILE="${SWAP_FILE:-/swapfile}"
SKIP_UFW="${SKIP_UFW:-}"
SKIP_SWAP="${SKIP_SWAP:-}"

printf "${BOLD}=== Admik · подготовка сервера (Ubuntu 24.04) ===${NC}\n\n"

# -----------------------------------------------------------------------------
# Проверка прав: нужен root (или sudo). Скрипт меняет систему (apt, swap, ufw).
# -----------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  fail "Запустите от root (или через sudo): sudo ./scripts/server-bootstrap.sh"
  exit 1
fi

# -----------------------------------------------------------------------------
# Шаг 1. Docker Engine + плагин docker compose
# -----------------------------------------------------------------------------
step "Шаг 1/4. Docker Engine + плагин docker compose"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker и плагин compose уже установлены ($(docker --version 2>/dev/null | head -1))"
else
  warn "Docker не найден — устанавливаю через официальный скрипт get.docker.com"
  # Официальный установочный скрипт Docker ставит Engine + плагин compose.
  # Идемпотентен: на уже настроенном сервере просто сообщит, что всё стоит.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  else
    # На чистой Ubuntu curl может отсутствовать — ставим его из apt.
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y curl ca-certificates
    curl -fsSL https://get.docker.com | sh
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker установлен ($(docker --version 2>/dev/null | head -1))"
  else
    fail "Установка Docker не удалась. Проверьте доступ в интернет и повторите."
    exit 1
  fi
fi
# Автозапуск демона при перезагрузке сервера (если есть systemd).
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker >/dev/null 2>&1 || warn "Не удалось включить автозапуск docker (продолжаю)"
fi

# -----------------------------------------------------------------------------
# Шаг 2. Swap-файл (страховка от OOM при сборке образов)
# -----------------------------------------------------------------------------
step "Шаг 2/4. Swap-файл (${SWAP_SIZE})"
if [ -n "${SKIP_SWAP}" ]; then
  warn "SKIP_SWAP задан — пропускаю настройку swap"
elif [ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]; then
  ok "Swap уже активен — пропускаю (swapon --show)"
elif [ -e "${SWAP_FILE}" ]; then
  warn "Файл ${SWAP_FILE} уже существует, но не активен — пропускаю создание"
  warn "При необходимости включите вручную: swapon ${SWAP_FILE}"
else
  # fallocate быстрее; при отсутствии — fallback на dd.
  if command -v fallocate >/dev/null 2>&1 && fallocate -l "${SWAP_SIZE}" "${SWAP_FILE}" 2>/dev/null; then
    :
  else
    warn "fallocate недоступен/не сработал — создаю swap через dd (медленнее)"
    # Переводим размер вида 4G/2G/512M в число блоков по 1 МиБ для dd.
    size_mib=$(numfmt --from=iec "${SWAP_SIZE}")
    size_mib=$((size_mib / 1024 / 1024))
    dd if=/dev/zero of="${SWAP_FILE}" bs=1M count="${size_mib}" status=none
  fi
  chmod 600 "${SWAP_FILE}"
  mkswap "${SWAP_FILE}" >/dev/null
  swapon "${SWAP_FILE}"
  # Подключать swap при загрузке (только если записи ещё нет).
  if ! grep -qE "^[^#]*[[:space:]]${SWAP_FILE}[[:space:]]" /etc/fstab 2>/dev/null \
     && ! grep -qE "^${SWAP_FILE}[[:space:]]" /etc/fstab 2>/dev/null; then
    printf '%s none swap sw 0 0\n' "${SWAP_FILE}" >> /etc/fstab
  fi
  ok "Swap создан и активирован (${SWAP_SIZE}, ${SWAP_FILE})"
fi

# -----------------------------------------------------------------------------
# Шаг 3. Firewall (ufw): SSH + HTTP + HTTPS
# -----------------------------------------------------------------------------
step "Шаг 3/4. Firewall (ufw): разрешаю 22/80/443"
if [ -n "${SKIP_UFW}" ]; then
  warn "SKIP_UFW задан — пропускаю настройку firewall"
else
  if ! command -v ufw >/dev/null 2>&1; then
    warn "ufw не найден — устанавливаю"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ufw
  fi
  # Разрешаем нужные порты (ufw allow идемпотентен — повтор не дублирует правило).
  ufw allow 22/tcp   >/dev/null   # SSH — иначе можно потерять доступ к серверу
  ufw allow 80/tcp   >/dev/null   # HTTP (Caddy: редирект на HTTPS + ACME-челлендж)
  ufw allow 443/tcp  >/dev/null   # HTTPS (витрина + Admik)
  # Включаем firewall без интерактивного подтверждения, если ещё выключен.
  if ufw status 2>/dev/null | grep -qi "Status: active"; then
    ok "ufw уже включён — правила 22/80/443 на месте"
  else
    ufw --force enable >/dev/null
    ok "ufw включён, открыты порты 22/80/443"
  fi
fi

# -----------------------------------------------------------------------------
# Шаг 4. Следующие шаги
# -----------------------------------------------------------------------------
step "Шаг 4/4. Готово. Дальнейшие шаги"
cat <<'NEXT'

Сервер подготовлен. Дальше разверните магазин (подробно — docs/09):

  1. Скачайте код (если ещё нет):
       git clone URL-репозитория admik && cd admik
       (рядом должна лежать витрина: каталог ./storefront)

  2. Заполните настройки:
       cp .env.example .env
       nano .env
     Минимум: SHOP_DOMAIN (домен витрины), ADMIN_DOMAIN (admin.<домен>),
     ACME_EMAIL, пароли БД/MinIO, OWNER_EMAIL. Публичный адрес API витрины —
     NEXT_PUBLIC_ADMIK_API_URL=https://admin.<домен>, медиа —
     S3_PUBLIC_URL=https://admin.<домен>/media/admik-media.

  3. В DNS создайте три A-записи на IP этого сервера:
       <домен>          A  <IP>
       www.<домен>      A  <IP>
       admin.<домен>    A  <IP>

  4. Поднимите стек (сборка + инициализация + smoke):
       make deploy
       (или: ./scripts/deploy.sh)

  5. Проверьте оба адреса:
       https://<домен>/            — витрина магазина
       https://admin.<домен>/admin/login — админка Admik

NEXT

printf "${GREEN}${BOLD}Подготовка сервера завершена.${NC}\n"
