# =============================================================================
# Admik — Makefile: тонкие алиасы над docker compose и scripts/ (Этап 6, 6.1)
# =============================================================================
# Цели — удобные сокращения для частых операций. Это НЕ единственный путь:
# всё работает и голыми командами из docs/09. Параметры берутся из .env.
#
#   make up      — поднять стек (docker compose up -d)
#   make init    — инициализировать магазин (миграции + seed)
#   make smoke   — проверить готовность (HTTP-проверки эндпоинтов)
#   make deploy  — единый сценарий: up → init → smoke (scripts/deploy.sh)
#   make logs    — смотреть логи стека (Ctrl-C для выхода)
#   make down    — остановить стек
#   make backup  — резервная копия БД и медиа (scripts/backup.sh)
#   make update  — обновление без простоя с откатом (scripts/update.sh)
# =============================================================================

# Все цели — не файлы, поэтому объявляем .PHONY (иначе одноимённый файл
# заблокировал бы запуск цели).
.PHONY: up init smoke deploy logs down backup update help

# Цель по умолчанию — показать справку.
.DEFAULT_GOAL := help

help:
	@echo "Admik — доступные команды:"
	@echo "  make up      — поднять стек (docker compose up -d)"
	@echo "  make init    — инициализировать магазин (миграции + seed)"
	@echo "  make smoke   — проверить готовность (smoke)"
	@echo "  make deploy  — up + init + smoke (единый сценарий)"
	@echo "  make logs    — смотреть логи стека"
	@echo "  make down    — остановить стек"
	@echo "  make backup  — резервная копия БД и медиа"
	@echo "  make update  — обновление без простоя с откатом"

up:
	docker compose up -d

# init-shop запускается ВНУТРИ контейнера app (там лежит по /app/scripts).
# -T отключает псевдо-TTY для неинтерактивного окружения.
init:
	docker compose exec -T app /app/scripts/init-shop.sh

smoke:
	./scripts/smoke.sh

deploy:
	./scripts/deploy.sh

# Логи всего стека; -f — следить в реальном времени.
logs:
	docker compose logs -f

down:
	docker compose down

# --- Резервное копирование и обновление (волны W2/W4) ----------------------
backup:
	./scripts/backup.sh

update:
	./scripts/update.sh
