-- =============================================================================
-- 0029_promo_scope_deactivate_on_empty.sql  (волна 5 — баг B: «мёртвая» акция)
-- ИНВАРИАНТ (docs/11 §5.2.3 + refinePromo, lib/orders/schemas.ts): scoped-промокод
-- (apply_scope IN ('category','brand','set')) ОБЯЗАН иметь ≥1 строку promo_targets.
-- Создание такого промокода без таргетов отклоняется Zod-валидацией.
--
-- ПРОБЛЕМА: promo_targets.{category_id,brand_id,product_id,variant_id} объявлены
-- ON DELETE CASCADE (0024). Жёсткое удаление товара/варианта/категории/бренда
-- (deleteProduct/deleteVariant/deleteCategory/deleteBrand) каскадно сносит цели.
-- Если у scoped-промокода это была единственная цель — он остаётся is_active=true
-- с пустым набором, scopeDiscountMinor молча даёт 0 («мёртвая» активная акция,
-- рассинхрон инварианта apply_scope↔promo_targets).
--
-- РЕШЕНИЕ (вариант А — на уровне БД, детерминированно): AFTER DELETE-триггер на
-- promo_targets. Если у затронутого promo_code apply_scope ∈ {category,brand,set}
-- и не осталось НИ ОДНОЙ строки promo_targets — в той же транзакции переводим
-- промокод в is_active=false. Так инвариант восстанавливается атомарно с каскадом.
-- Промокод не удаляется (история/аудит сохраняются), но перестаёт применяться.
--
-- SECURITY DEFINER: каскадный DELETE инициирует роль рантайма (admik_app);
-- функция выполняется от владельца (admik_migrator), чтобы UPDATE promo_codes
-- сработал независимо от прав инициатора каскада. search_path фиксируем (public)
-- против подмены (CVE-класс SECURITY DEFINER).
--
-- Идемпотентно/повторно-запускаемо: CREATE OR REPLACE FUNCTION;
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER (DROP TRIGGER IF EXISTS — НЕ деструктив
-- схемы данных, линтер аддитивности ловит только DROP TABLE/COLUMN/CONSTRAINT/
-- DEFAULT/NOT NULL/INDEX, RENAME, ALTER TYPE/смену типа enum — не DROP TRIGGER).
-- Аддитивно: новый объект (функция+триггер), существующий код не затрагивается.
-- =============================================================================

-- Функция-обработчик AFTER DELETE: гасит scoped-промокод, оставшийся без целей.
CREATE OR REPLACE FUNCTION promo_targets_deactivate_orphan_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- OLD.promo_code_id — акция, у которой только что удалили таргет (каскадом
  -- из каталога или прямым DELETE). Гасим её ТОЛЬКО если:
  --   * apply_scope требует таргеты (category/brand/set), И
  --   * целей у неё больше не осталось (последняя цель снесена каскадом).
  -- Для apply_scope='cart' таргеты не нужны — там ничего не делаем.
  UPDATE promo_codes p
     SET is_active  = false,
         updated_at = now()
   WHERE p.id = OLD.promo_code_id
     AND p.apply_scope IN ('category', 'brand', 'set')
     AND p.is_active = true
     AND NOT EXISTS (
       SELECT 1 FROM promo_targets t WHERE t.promo_code_id = OLD.promo_code_id
     );
  RETURN NULL;  -- AFTER-триггер: возвращаемое значение игнорируется.
END;
$$;

-- Триггер AFTER DELETE построчно (FOR EACH ROW): нужен OLD.promo_code_id каждой
-- удаляемой цели. DROP TRIGGER IF EXISTS перед CREATE — для повторного наката
-- (CREATE TRIGGER не поддерживает OR REPLACE до PG14, держим совместимо).
DROP TRIGGER IF EXISTS promo_targets_deactivate_orphan_scope_trg ON promo_targets;
CREATE TRIGGER promo_targets_deactivate_orphan_scope_trg
  AFTER DELETE ON promo_targets
  FOR EACH ROW
  EXECUTE FUNCTION promo_targets_deactivate_orphan_scope();

INSERT INTO schema_migrations (version, name)
VALUES ('0029', 'promo_scope_deactivate_on_empty')
ON CONFLICT DO NOTHING;
