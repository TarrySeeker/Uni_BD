# scripts/bare-metal — деплой без Docker (опционально)

Альтернатива `docker compose` для окружений без Docker: приложения — systemd-сервисы
(Next.js prod), Caddy — reverse-proxy с авто-TLS. Дефолт платформы остаётся Docker.
Контекст — `docs/25-без-docker-профиль.md`.

```bash
# 1) собрать прод (админка + витрина):
node node_modules/next/dist/bin/next build
(cd storefront && node node_modules/next/dist/bin/next build)
# 2) деплой (system-юниты → root; -E чтобы прокинуть env):
SHOP_DOMAIN=example.com ADMIN_DOMAIN=admin.example.com APP_DIR=$PWD \
  sudo -E bash scripts/bare-metal/deploy.sh
```

Параметры (env): `SHOP_DOMAIN` (обяз.), `ADMIN_DOMAIN` (дефолт `admin.$SHOP_DOMAIN`),
`WEB_PORT` (3001), `ADMIN_PORT` (8080), `APP_DIR` (обяз., корень платформы),
`WEB_DIR` (`$APP_DIR/storefront`), `NODE_BIN`, `ACME_EMAIL`, `DEPLOY_STOREFRONT` (0 — только админка).

Требования: DNS доменов → сервер; открытые 80/443 у провайдера; собранные `.next`.

## Совсем без sudo (user-space)
- Сервисы через `systemctl --user` (положить юниты в `~/.config/systemd/user/`) +
  `loginctl enable-linger $USER` — переживут выход из сессии.
- Привилегированные :80/:443 без root: либо reverse-proxy на порту >1024 + внешний
  LB, либо разово `sudo setcap 'cap_net_bind_service=+ep' $(command -v caddy)`.
- БД — `scripts/dev-db` (embedded-postgres, тоже без sudo).
