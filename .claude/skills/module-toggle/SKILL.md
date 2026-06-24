---
name: module-toggle
description: Включить или выключить функциональный модуль магазина (catalog/orders/cdek/cms/payments) корректным способом — через env ADMIK_MODULES или БД-override shop_settings.module_overrides, с обязательным рестартом app при прямой правке БД.
---

# Переключение модуля admik

Активные модули = `ADMIK_MODULES` в `.env` (по умолчанию `catalog,orders,cdek,cms`)
И/ИЛИ override в БД `shop_settings.module_overrides`. Мультитенантность: модули конфигурируются, не хардкодятся.

## Способ A — через .env (предпочтительно при деплое)
1. Добавь/убери модуль в `ADMIK_MODULES` в `.env`.
2. Передеплой/пересоздание `app` (`make deploy` локально, либо скилл `deploy-stand` на стенде).

## Способ B — через БД-override (быстрый тумблер на стенде)
> Доступы стенда — в памяти проекта `admik-stand-deploy` (вне репо), не хардкодить.

1. Правка `shop_settings.module_overrides` через UI/settings-action — ПРЕДПОЧТИТЕЛЬНО (кэш сам инвалидируется).
2. Если правил `module_overrides` ПРЯМЫМ SQL (не через экшен) — memo-кэш эффективных настроек
   НЕ инвалидируется → ОБЯЗАТЕЛЬНО `docker compose restart app`. Иначе рантайм отдаёт старый набор
   и модуль вернёт `module_disabled`.

## Проверка (две проверки)
- Код: `pnpm test` по гейтам модулей.
- Живая: после рестарта дёрни функцию модуля (payments — `initPayment` card/sbp; cdek — расчёт/ПВЗ)
  через `verify-admin.mjs` или браузер. Health: `curl …/api/health?deep=1` → `ok`.

## Итог
Какой модуль, каким способом (env/БД), сделан ли рестарт, результат живой проверки.
