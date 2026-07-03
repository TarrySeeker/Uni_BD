# scripts/dev-db — локальная БД без Docker/sudo

Подъём эфемерного PostgreSQL для dev/CI/автосессии **без Docker и без системного psql**
через npm-пакет `embedded-postgres`. Подробности и контекст — `docs/25-без-docker-профиль.md`.

```bash
pnpm install                        # ставит embedded-postgres
pnpm db:up &                        # = node scripts/dev-db/start.mjs (127.0.0.1:5442)
PGHOST=127.0.0.1 PGPORT=5442 PGUSER=postgres PGPASSWORD=postgres pnpm db:init
export DATABASE_URL=postgres://admik_app:app-local@127.0.0.1:5442/admik
pnpm dev
```

- `start.mjs` — поднять сервер (порт `PGPORT`, каталог `PGDATA`, дефолт `./data`, gitignored).
- `init-db.mjs` — схема+роли+seed через postgres.js (обходит psql-only `0001`; иммутабельную миграцию не меняет). `FRESH=1` — пересоздать БД начисто.
- Боевой путь (Docker) — `scripts/init-shop.sh` внутри контейнера; этот раннер его дополняет.
