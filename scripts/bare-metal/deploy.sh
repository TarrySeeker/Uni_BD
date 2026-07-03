#!/usr/bin/env bash
# ============================================================================
# ОПЦИОНАЛЬНЫЙ bare-metal деплой-профиль (БЕЗ Docker) — альтернатива docker compose.
# ============================================================================
# Дефолт платформы — Docker (docker-compose.yml + scripts/deploy.sh). Этот профиль
# для окружений, где Docker недоступен/нежелателен: приложения запускаются как
# systemd-сервисы (Next.js prod), а Caddy проксирует на localhost-порты и берёт
# авто-TLS Let's Encrypt (та же схема доменов, что в корневом Caddyfile).
#
#   Витрина  →  https://$SHOP_DOMAIN  (+ www→apex)  → Next prod :$WEB_PORT
#   Админка  →  https://$ADMIN_DOMAIN               → Next prod :$ADMIN_PORT
#   БД       →  127.0.0.1:$PGPORT (embedded-postgres, scripts/dev-db) или свой Postgres
#
# Ниша-агностичен: НИКАКОЙ бизнес-специфики магазина. Все параметры — через env.
# Запуск (root — для system-юнитов):  sudo -E bash scripts/bare-metal/deploy.sh
# No-sudo вариант — см. README (systemctl --user + loginctl enable-linger).
# ============================================================================
set -euo pipefail

# ---------- параметры (через env; ниже — дефолты) ----------
SHOP_DOMAIN="${SHOP_DOMAIN:?задай SHOP_DOMAIN=example.com}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-admin.${SHOP_DOMAIN}}"
WEB_PORT="${WEB_PORT:-3001}"
ADMIN_PORT="${ADMIN_PORT:-8080}"
APP_USER="${APP_USER:-$(logname 2>/dev/null || echo "$SUDO_USER")}"
APP_DIR="${APP_DIR:?задай APP_DIR=/path/to/admik (корень платформы)}"
WEB_DIR="${WEB_DIR:-${APP_DIR}/storefront}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
ACME_EMAIL="${ACME_EMAIL:-}"
DEPLOY_STOREFRONT="${DEPLOY_STOREFRONT:-1}"   # 0 — только админка
# -----------------------------------------------------------

[ "$(id -u)" -eq 0 ] || { echo "Запусти через sudo -E:  sudo -E bash $0"; exit 1; }

SERVER_IP4="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
free_port() { command -v fuser >/dev/null && fuser -k "${1}/tcp" 2>/dev/null || true; }

unit() { # $1=name $2=workdir $3="ExecStart..." — генерирует /etc/systemd/system/$1.service
  cat >/etc/systemd/system/"$1".service <<EOF
[Unit]
Description=$1 (Next.js prod, bare-metal)
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=$2
Environment=NODE_ENV=production
Environment=REDIS_URL=
ExecStart=$3
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

echo "== 1/5 пакеты: Caddy + psmisc =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg psmisc
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
systemctl disable --now nginx 2>/dev/null || true   # освободить :80/:443 если был nginx

echo "== 2/5 сборки (Next .next) =="
[ -f "${APP_DIR}/.next/BUILD_ID" ] || { echo "  НЕТ сборки админки: (cd ${APP_DIR} && ${NODE_BIN} node_modules/next/dist/bin/next build)"; exit 1; }
if [ "$DEPLOY_STOREFRONT" = "1" ]; then
  [ -f "${WEB_DIR}/.next/BUILD_ID" ] || { echo "  НЕТ сборки витрины: (cd ${WEB_DIR} && ${NODE_BIN} node_modules/next/dist/bin/next build)"; exit 1; }
fi

echo "== 3/5 systemd-сервисы приложений =="
unit admik-app "${APP_DIR}" "${NODE_BIN} node_modules/next/dist/bin/next start -p ${ADMIN_PORT} -H 127.0.0.1"
SERVICES=(admik-app)
if [ "$DEPLOY_STOREFRONT" = "1" ]; then
  unit admik-storefront "${WEB_DIR}" "${NODE_BIN} node_modules/next/dist/bin/next start -p ${WEB_PORT} -H 127.0.0.1"
  SERVICES+=(admik-storefront)
fi
systemctl daemon-reload
for s in "${SERVICES[@]}"; do systemctl stop "$s" 2>/dev/null || true; done
free_port "${ADMIN_PORT}"; [ "$DEPLOY_STOREFRONT" = "1" ] && free_port "${WEB_PORT}"
sleep 2
systemctl reset-failed "${SERVICES[@]}" 2>/dev/null || true
for s in "${SERVICES[@]}"; do systemctl enable --now "$s"; done
sleep 5
for s in "${SERVICES[@]}"; do
  systemctl is-active "$s" >/dev/null 2>&1 && echo "  $s: active" || { echo "  ОШИБКА: $s"; journalctl -u "$s" --no-pager -n 20; exit 1; }
done

echo "== 4/5 Caddyfile (авто-HTTPS) =="
{
  [ -n "$ACME_EMAIL" ] && printf '{\n    email %s\n}\n\n' "$ACME_EMAIL"
  cat <<EOF
(security_headers) {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
}
www.${SHOP_DOMAIN} {
    import security_headers
    redir https://${SHOP_DOMAIN}{uri} permanent
}
${SHOP_DOMAIN} {
    import security_headers
    reverse_proxy 127.0.0.1:${WEB_PORT}
}
${ADMIN_DOMAIN} {
    import security_headers
    reverse_proxy 127.0.0.1:${ADMIN_PORT}
}
:80 {
    import security_headers
    reverse_proxy 127.0.0.1:${WEB_PORT}
}
EOF
} > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile 2>/dev/null || true
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy 2>/dev/null || true
systemctl restart caddy

echo "== 5/5 проверка DNS (для авто-TLS) =="
for d in "$SHOP_DOMAIN" "$ADMIN_DOMAIN"; do
  if getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | grep -qx "$SERVER_IP4"; then
    echo "  ✅ $d → сервер"
  else
    echo "  ⚠ $d НЕ указывает на ${SERVER_IP4} — добавь A-запись; Caddy выпустит TLS сам, как появится DNS"
  fi
done
echo ""
echo "ГОТОВО:  витрина https://${SHOP_DOMAIN}   админка https://${ADMIN_DOMAIN}/admin"
echo "Firewall провайдера: открыть 80 и 443."
