-- =============================================================================
-- 0034_personalization.sql — персонализация позиции заказа (универсальный механизм)
--
-- Зачем. Платформа умела продавать только готовые позиции: строка корзины — это
-- `variantId + qty`, и больше в неё положить нечего. Магазину, который продаёт
-- изделие «под покупателя» (гравировка, вышивка, печать, подарочная надпись),
-- этого не хватает принципиально: заказ доезжает до цеха без того, ЧТО именно
-- наносить. Ниша разная, механизм один — поэтому он в платформе, а не в магазине.
--
-- Две колонки, две разные роли:
--
--   products.personalization  — ОПИСАНИЕ полей, которые заполняет покупатель
--                               (какие, как называются, каковы пределы). Задаёт
--                               владелец в карточке товара. NULL — товар без
--                               персонализации, обычная позиция как раньше.
--
--   order_items.personalization — СНИМОК заполненных значений на момент заказа.
--                               Тот же принцип, что у name_snapshot/unit_price
--                               (ADR-010): правка карточки товара не должна
--                               менять то, что уже уехало в производство.
--
-- Почему jsonb, а не таблица полей. Набор полей — это КОНФИГУРАЦИЯ товара, а не
-- сущность со своей жизнью: он всегда читается и пишется целиком вместе с
-- товаром, на него не ссылаются, по нему не джойнят. Отдельная таблица дала бы
-- три джойна и порядок сортировки на каждое чтение карточки, не дав ничего
-- взамен. Форма значений валидируется в коде (lib/personalization) — СЕРВЕРОМ,
-- а не браузером: Server Action и Storefront API — это HTTP-эндпоинты, и «из
-- формы такое не придёт» защитой не является (docs/32 §8).
--
-- CHECK на тип: колонки обязаны быть объектом, а не массивом или строкой.
-- Это дешёвая страховка от мусора; содержательная схема — в Zod.
--
-- Идемпотентно/аддитивно: ADD COLUMN IF NOT EXISTS, CHECK через pg_constraint,
-- запись в журнал — ON CONFLICT DO NOTHING. Проходит scripts/check-migrations.sh:
-- добавление колонки с NOT NULL DEFAULT совместимо со старым кодом (вставка без
-- значения получит дефолт), products.personalization — nullable.
-- =============================================================================

ALTER TABLE products    ADD COLUMN IF NOT EXISTS personalization jsonb;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS personalization jsonb NOT NULL DEFAULT '{}'::jsonb;

-- CHECK-ограничения объявляем через pg_constraint: ADD CONSTRAINT не поддерживает
-- IF NOT EXISTS в PostgreSQL 15, а миграция обязана быть идемпотентной.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_personalization_is_object'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_personalization_is_object
      CHECK (personalization IS NULL OR jsonb_typeof(personalization) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_personalization_is_object'
  ) THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_personalization_is_object
      CHECK (jsonb_typeof(personalization) = 'object');
  END IF;
END
$$;

-- Частичный индекс: витрине и админке нужен быстрый ответ на «какие товары
-- вообще персонализируются». Полный индекс по jsonb здесь не нужен — по
-- содержимому персонализации не ищут, её только читают вместе с товаром.
CREATE INDEX IF NOT EXISTS products_personalization_idx
  ON products ((personalization IS NOT NULL))
  WHERE personalization IS NOT NULL;

-- GRANT не нужен: права на products (0006) и order_items (0012) уже выданы,
-- новые столбцы наследуют табличные привилегии роли admik_app.

INSERT INTO schema_migrations (version, name)
VALUES ('0034', 'personalization')
ON CONFLICT DO NOTHING;
