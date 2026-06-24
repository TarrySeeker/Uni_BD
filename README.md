# Uni_BD — универсальная админка + БД для интернет-магазина (платформа Admik)

**Uni_BD** — готовый кит: headless-бэкенд, **административная панель**, **база данных**
(PostgreSQL, 31 миграция), публичный **Storefront API**, интеграции (СДЭК, Т-Банк),
CMS, DevOps (Docker/Caddy) и мультиагентный инструментарий Claude Code.

Назначение: репозиторий копируется в проект, где **уже есть готовый макет витрины**
магазина (Next.js, без БД и без админки). Задача — **прикрутить к макету эту админку
и БД** и ретематизировать данные под нишу магазина, **не трогая бизнес-логику
платформы**. Витрина становится чистым потребителем `/api/storefront/v1/*`.

> 👉 **Новая сессия Claude Code: начни с [`START-HERE.md`](START-HERE.md).**
> Затем `CLAUDE.md` → `docs/20-онбординг-витрины-playbook.md` →
> `docs/21-контракт-storefront-api.md`, после — запусти скилл **`/onboard-shop`**.

## Модель «1 магазин = 1 БД»

Каждый магазин = отдельная БД + конфигурация на отдельном VPS. Кодовая база едина и
не меняется между магазинами. Меняются только **конфигурация** (`.env` + таблица
`shop_settings`: реквизиты, ключи, модули, брендинг) и **содержимое БД** (каталог,
контент). Подробнее — [`docs/02-модель-развёртывания.md`](docs/02-модель-развёртывания.md).

## Стек

| Слой | Технология |
|------|-----------|
| Рантайм | Node 20+ |
| Фреймворк | Next.js 16 (App Router, `output: 'standalone'`) |
| UI | React 19 + Tailwind CSS |
| Язык | TypeScript (strict) |
| БД | PostgreSQL 15+ через postgres.js · Redis (ioredis) · S3/MinIO (sharp) |
| Валидация | Zod · Тесты: Vitest (юнит) + Playwright (e2e) |
| Пакетный менеджер | pnpm · DevOps: Docker + Caddy (auto-TLS) |

Архитектура — [`docs/01-архитектурные-решения.md`](docs/01-архитектурные-решения.md);
полный стек — [`docs/16-стек-технологий.md`](docs/16-стек-технологий.md).

## Быстрый старт

```bash
pnpm install
cp .env.example .env     # заполнить под магазин (см. START-HERE.md §6)
make up                  # docker compose up -d (app+postgres+redis+minio+caddy)
make init                # init-shop.sh: миграции → seed прав/ролей/владельца
make smoke               # health-проверки
```
Health: `GET /api/health` → `{ "status": "ok", ... }`. Админка: `/admin`.

## Проверки качества (две обязательные)

```bash
pnpm typecheck   # tsc --noEmit (0 ошибок)
pnpm lint        # eslint
pnpm test        # vitest run
```
Скилл `/gate` — полный код-гейт (первая проверка). Живой прогон в браузере
(`/deploy-stand` / `/verify`) — вторая проверка. Принцип: **сначала тесты, потом код**.

## Структура

```
app/admin/             — административная панель
app/api/storefront/v1/ — публичный Storefront API (контракт — docs/21)
lib/                   — бизнес-логика по доменам (catalog/orders/cdek/cms/…)
db/migrations/         — идемпотентные SQL-миграции (иммутабельны)
db/seed/               — roles/permissions + нейтральный demo-catalog
scripts/               — init-shop, deploy, backup/restore, update, smoke
.claude/agents|skills/ — 9 субагентов + скиллы (onboard-shop, gate, …)
docs/                  — документация (00–21)
```

## Документация

- [START-HERE](START-HERE.md) · [Плейбук онбординга](docs/20-онбординг-витрины-playbook.md) · [Контракт Storefront API](docs/21-контракт-storefront-api.md)
- [Архитектура (ADR)](docs/01-архитектурные-решения.md) · [Развёртывание](docs/09-инструкция-разворачивания.md) · [Инструментарий MCP/скиллы](docs/19-инструментарий-mcp-скиллы.md)
- [Журнал проекта](docs/00-журнал-проекта.md) · [Состояние и продолжение](docs/10-состояние-и-продолжение.md)

> Платформа обкатана на реальной витрине (worked-example сращивания — `docs/13`).
> Бизнес-логика покрыта ~1100 юнит-тестами; адверсариальный аудит сошёлся.
