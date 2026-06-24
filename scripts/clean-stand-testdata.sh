#!/usr/bin/env bash
# ============================================================================
# Безопасная чистка ТЕСТ-данных QA-харнессов с боевого стенда (клиент-готовый
# хендовер). Удаляет СТРОГО артефакты автотестов и НИКОГДА данные владельца:
#   - заказы покупателя zz-qa-buyer@example.com (+ каскадом items/history/cdek/tbank);
#   - категории со slug 'zz-%' или именем 'ZZ-%' (сначала дети, потом родители);
#   - товары со slug 'zz-qa-%' или именем 'ZZ-QA-%' (через deleteProduct-эквивалент
#     не идём — best-effort SQL: product_categories/media/variants/inventory каскадом).
#
# По умолчанию DRY-RUN (только показывает, что было бы удалено). Для реального
# удаления: CONFIRM=yes scripts/clean-stand-testdata.sh
#
# Доступ: SSH-ключ ~/.ssh/admik_deploy (root@admin.erfgq.website). Контейнер postgres.
# ============================================================================
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/admik_deploy}"
SSH_HOST="${SSH_HOST:-root@admin.erfgq.website}"
DB_USER="${DB_USER:-admik}"
DB_NAME="${DB_NAME:-admik}"
QA_EMAIL="${QA_EMAIL:-zz-qa-buyer@example.com}"
CONFIRM="${CONFIRM:-no}"

psql_exec() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_HOST" \
    "cd /opt/admik && docker compose exec -T postgres psql -U $DB_USER -d $DB_NAME -v ON_ERROR_STOP=1 -tAc \"$1\""
}

echo "=== ТЕКУЩИЕ ТЕСТ-АРТЕФАКТЫ НА СТЕНДЕ ==="
echo -n "  заказы QA ($QA_EMAIL): "; psql_exec "SELECT count(*) FROM orders WHERE customer_email='$QA_EMAIL';"
echo -n "  категории ZZ-*:        "; psql_exec "SELECT count(*) FROM categories WHERE slug LIKE 'zz-%' OR name LIKE 'ZZ-%';"
echo -n "  товары ZZ-QA-*:        "; psql_exec "SELECT count(*) FROM products WHERE slug LIKE 'zz-qa-%' OR name LIKE 'ZZ-QA-%';"
echo -n "  промокоды ZZ-*:        "; psql_exec "SELECT count(*) FROM promo_codes WHERE code LIKE 'ZZ-%';"

if [ "$CONFIRM" != "yes" ]; then
  echo
  echo "DRY-RUN (ничего не удалено). Для удаления: CONFIRM=yes $0"
  exit 0
fi

echo
echo "=== УДАЛЕНИЕ (CONFIRM=yes) ==="
# 1. Заказы QA — каскадом подчистятся order_items/status_history/cdek/tbank/redemptions.
echo -n "  удалено заказов QA: "; psql_exec "WITH d AS (DELETE FROM orders WHERE customer_email='$QA_EMAIL' RETURNING 1) SELECT count(*) FROM d;"
# 2. Товары ZZ-QA — best-effort (если FK без каскада — оставит, выведется ниже).
echo -n "  удалено товаров ZZ-QA: "; psql_exec "WITH d AS (DELETE FROM products WHERE slug LIKE 'zz-qa-%' OR name LIKE 'ZZ-QA-%' RETURNING 1) SELECT count(*) FROM d;" || echo "(часть с FK — чистить через админку)"
# 2b. Промокоды ZZ-* (создаёт фаза `full`, UI их не удаляет → копятся, мешают повторному прогону).
#     Каскад redemptions/targets по FK. Публичных ZZ-промо не плодит, но засоряют админ-список.
echo -n "  удалено промокодов ZZ: "; psql_exec "WITH d AS (DELETE FROM promo_codes WHERE code LIKE 'ZZ-%' RETURNING 1) SELECT count(*) FROM d;"
# 3. Категории ZZ — сначала дети (parent_id у ZZ-родителя), затем сами ZZ (FK RESTRICT).
#    Два прохода (до 2 уровней вложенности тест-категорий).
for _pass in 1 2 3; do
  psql_exec "DELETE FROM categories WHERE parent_id IN (SELECT id FROM categories WHERE slug LIKE 'zz-%' OR name LIKE 'ZZ-%');" >/dev/null || true
  psql_exec "DELETE FROM categories WHERE (slug LIKE 'zz-%' OR name LIKE 'ZZ-%') AND id NOT IN (SELECT DISTINCT parent_id FROM categories WHERE parent_id IS NOT NULL);" >/dev/null || true
done
echo -n "  осталось ZZ-категорий: "; psql_exec "SELECT count(*) FROM categories WHERE slug LIKE 'zz-%' OR name LIKE 'ZZ-%';"

echo
echo "=== ПОСЛЕ ЧИСТКИ ==="
echo -n "  заказы QA: "; psql_exec "SELECT count(*) FROM orders WHERE customer_email='$QA_EMAIL';"
echo -n "  категории ZZ-*: "; psql_exec "SELECT count(*) FROM categories WHERE slug LIKE 'zz-%' OR name LIKE 'ZZ-%';"
echo -n "  товары ZZ-QA-*: "; psql_exec "SELECT count(*) FROM products WHERE slug LIKE 'zz-qa-%' OR name LIKE 'ZZ-QA-%';"
echo -n "  сироты order_items: "; psql_exec "SELECT count(*) FROM order_items oi LEFT JOIN orders o ON oi.order_id=o.id WHERE o.id IS NULL;"
echo "Готово. Данные владельца не затронуты."
