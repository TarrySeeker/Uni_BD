---
name: deploy-stand
description: Задеплоить Admik и/или витрину на боевой стенд по схеме rsync→build→up→health-gate с предохранителями (.env не трогать, точка отката) и живым прогоном. Применять для выкатки изменений на стенд как «вторую из двух проверок».
---

# Деплой на стенд admik

> ДОСТУПЫ СТЕНДА (SSH-хост, ключ, домены) НЕ хранятся в репозитории.
> Бери их из памяти проекта `admik-stand-deploy` (вне репо) или из переменных окружения:
> `ADMIK_DEPLOY_HOST` (`user@host`), `ADMIK_DEPLOY_SSH_KEY` (путь к ключу),
> `ADMIK_ADMIN_DOMAIN`, `ADMIK_STORE_DOMAIN`. Никогда не коммить хосты/ключи/пароли.
> Стенд — ВЫГРУЗКА кода (НЕ git-клон), деплой вручную по схеме, эквивалентной `scripts/update.sh`.

## КРИТИЧНО ПЕРЕД `rsync --delete`
Боевой `.env` на стенде НЕ в репозитории → `rsync --delete` БЕЗ `--exclude '.env'`
его УДАЛИТ (так уже было однажды). ВСЕГДА исключай `.env` и `backups`.

## Шаги
1. **Предполётный гейт:** прогони скилл `gate` локально (зелёный). Без этого не деплоить.
2. **rsync кода Admik:**
   `rsync -az --delete --exclude '.env' --exclude .git --exclude node_modules --exclude .next --exclude 'storefront' --exclude backups -e "ssh -i $ADMIK_DEPLOY_SSH_KEY" ./ "$ADMIK_DEPLOY_HOST":/opt/admik/`
3. **rsync витрины** (если менялась) — отдельной командой её `src/` (+ `public` при изменении).
4. **Точка отката:** на стенде tag текущего образа в `:rollback` + предеплойный дамп в `/opt/admik/backups/predeploy-<ts>.sql`.
5. **Сборка:** `cd /opt/admik && docker compose build app` (и/или `storefront`).
6. **Миграции** (если схемные) — штатно под ролью мигратора.
7. **Подъём:** `docker compose up -d app storefront`.
8. **Health-gate:** `curl "https://$ADMIK_ADMIN_DOMAIN/api/health?deep=1"` → `ok` по db/redis/s3.
   При провале — retag `:rollback` → `up -d` + restore предеплойного дампа.

## Если правил `shop_settings` ПРЯМЫМ SQL (не через UI/экшен)
memo-кэш эффективных настроек инвалидируется только через settings-action →
после прямой SQL-правки нужен `docker compose restart app`. Правки через UI/экшены видны без рестарта.

## Живая проверка (вторая из двух)
`node scripts/verify-admin.mjs <full|sections|e2e>` (Playwright; браузеры в `~/.cache/ms-playwright`).
- `e2e` — браузерный проклик ВИТРИНЫ: каталог → карточка → корзина → оплата (mock).
Тест-данные с префиксом `ZZ-QA-` чистятся фазой `cleanup`. Данные владельца НЕ удалять.

## Итог
Сводка: что задеплоено, health `ok/fail`, результат `verify-admin`.
Деплой/коммит — только при разрешении владельца (рабочая ветка в origin не пушится без его слова).
