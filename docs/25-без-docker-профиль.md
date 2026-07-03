# 25 — Профиль «без Docker / без sudo» (dev-БД + bare-metal деплой)

> **Дефолт платформы — Docker** (`docker-compose.yml`, `make up`, `scripts/deploy.sh`).
> Этот профиль — АЛЬТЕРНАТИВА для окружений, где Docker/sudo недоступны: локальная
> разработка, CI, или **автоматизированная сессия ассистента на «голом» хосте**.
> Ниша-агностичен: никакой бизнес-специфики магазина.

Почему нужен: у Postgres нет in-memory fallback (в отличие от Redis/S3), а штатный
`scripts/init-shop.sh` требует клиентские бинарники `psql`/`pg_isready`, миграция
`0001` — psql-only (`\gexec`, `:'VAR'`), а `server-bootstrap.sh`/`make up` требуют
Docker+root. Значит без этого профиля автосессия не может поднять БД.

## 1. Локальная БД без Docker/sudo — `scripts/dev-db/`

`embedded-postgres` (npm, devDependency) скачивает нативный бинарь PostgreSQL в
`node_modules` при `pnpm install` — ни Docker, ни системного psql, ни sudo.

```bash
pnpm install                        # включает embedded-postgres
node scripts/dev-db/start.mjs &     # Postgres на 127.0.0.1:$PGPORT (дефолт 5442)
# инициализация схемы через postgres.js (обходит psql-измы 0001):
PGHOST=127.0.0.1 PGPORT=5442 PGUSER=postgres PGPASSWORD=postgres \
  node scripts/dev-db/init-db.mjs   # FRESH=1 — снести и пересоздать
export DATABASE_URL=postgres://admik_app:app-local@127.0.0.1:5442/admik
pnpm dev
```

- **`start.mjs`** — поднимает эфемерный Postgres (каталог `scripts/dev-db/data`, gitignored). Порт/каталог — env `PGPORT`/`PGDATA`.
- **`init-db.mjs`** — `postgres.js`-раннер: создаёт БД → bootstrap (расширения + роли `admik_migrator`/`admik_app` least-privilege + journal `schema_migrations` + эффект `0001`) → накатывает `db/migrations/*` под `admik_migrator` → seed `db/seed/{permissions,roles}.sql`. **Иммутабельную `0001` НЕ меняет** — воспроизводит её эффект в JS и пропускает в цикле (psql-only `\gexec` обычным драйвером не накатить). Проверено: 33 миграции → 36 таблиц, 12 прав.
- Боевой путь (VPS с Docker) остаётся штатным — `scripts/init-shop.sh` внутри контейнера; этот раннер его дополняет, а не заменяет.

## 2. Postgres-only: Redis и MinIO НЕ нужны

Рантайм переносим: нет Redis → in-memory rate-limit (`lib/auth/rate-limit.ts`); нет
S3/MinIO → локальное файловое хранилище (`lib/storage`); `/api/health` помечает их
`skipped` (критичен только `db`), статус остаётся `ok`. Для профиля без Docker —
**оставь `REDIS_URL` и `S3_*`/`MINIO_*` пустыми** в `.env` (см. `.env.example`).

## 3. Боевой деплой без Docker — bare-metal профиль `scripts/bare-metal/`

Опциональная альтернатива `docker compose`: приложения — systemd-сервисы (Next.js
prod), Caddy — reverse-proxy с авто-TLS (та же схема доменов, что корневой `Caddyfile`):
витрина на apex (`$SHOP_DOMAIN` + www→apex), админка на `$ADMIN_DOMAIN`.

```bash
# сборки:
(cd . && node node_modules/next/dist/bin/next build)
(cd storefront && node node_modules/next/dist/bin/next build)
# деплой (system-юниты — root):
SHOP_DOMAIN=example.com ADMIN_DOMAIN=admin.example.com APP_DIR=$PWD \
  sudo -E bash scripts/bare-metal/deploy.sh
```

Ставит Caddy, заводит `admik-app.service` (+ `admik-storefront.service`), пишет
`/etc/caddy/Caddyfile`, выпускает TLS. Все параметры — env (`SHOP_DOMAIN`,
`ADMIN_DOMAIN`, `WEB_PORT`, `ADMIN_PORT`, `APP_DIR`, `WEB_DIR`, `ACME_EMAIL`,
`DEPLOY_STOREFRONT`).

**Без sudo вообще** (user-space): вместо system-юнитов — `systemctl --user` +
`loginctl enable-linger $USER` (сервисы переживут выход из сессии), а перед :80/:443
нужен reverse-proxy с правом на привилегированные порты (или разово
`setcap cap_net_bind_service`). Подробности — `scripts/bare-metal/README.md`.

## Что осталось Docker-дефолтом (не тронуто)
`docker-compose.yml`, `Dockerfile`, `scripts/{deploy,server-bootstrap,init-shop}.sh`,
`Makefile`, `Caddyfile` — рекомендованный боевой путь. Профиль без Docker их не заменяет.
