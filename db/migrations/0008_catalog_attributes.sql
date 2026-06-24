-- =============================================================================
-- 0008_catalog_attributes.sql
-- -----------------------------------------------------------------------------
-- Этап 2, пакет П1 — каталог: характеристики (справочная EAV, docs/05 §2.4, ADR-007).
--   * attributes        — определение характеристики (метаданные → форма строится сама).
--   * attribute_values  — словарь допустимых значений для select-атрибутов.
--   * product_attributes — привязка характеристики к товару ИЛИ к варианту.
--
-- Идемпотентно: CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- value_id → ON DELETE RESTRICT: нельзя удалить значение, пока оно используется (§2.7).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- attributes (§2.4). code citext — стабильный ключ импорта ('color','size').
-- Метаданные (type/unit/is_variant/is_filterable/is_required) → админка строит
-- форму ввода характеристик автоматически (универсальность, ADR-003/ADR-007).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attributes (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  code        citext  NOT NULL,                  -- стабильный код: 'color','size','material'
  name        text    NOT NULL,                  -- человекочитаемое имя для UI
  type        text    NOT NULL DEFAULT 'select'  -- тип значения характеристики
              CHECK (type IN ('select','text','number','boolean')),
  unit        text,                              -- единица измерения ('см','кг','мл'); из настроек
  is_variant  boolean NOT NULL DEFAULT false,    -- участвует ли в образовании вариантов
  is_filterable boolean NOT NULL DEFAULT true,   -- показывать в фасетных фильтрах витрины
  is_required boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attributes_code_uniq ON attributes (code);

-- -----------------------------------------------------------------------------
-- attribute_values (§2.4) — словарь значений select-атрибутов (единые «Красный/Синий»).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attribute_values (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_id uuid    NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  value        text    NOT NULL,                 -- 'Красный', 'M', '42'
  slug         citext,                           -- опц. ЧПУ-код значения для фильтров
  sort         integer NOT NULL DEFAULT 0,
  UNIQUE (attribute_id, value)
);
CREATE INDEX IF NOT EXISTS attribute_values_attr_idx ON attribute_values (attribute_id, sort);

-- -----------------------------------------------------------------------------
-- product_attributes (§2.4) — привязка к товару (variant_id NULL) ИЛИ к варианту.
-- value_id (select, RESTRICT) ИЛИ value_text (text/number/boolean); CHECK — хотя бы одно.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_attributes (
  id            uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid   NOT NULL REFERENCES products(id)         ON DELETE CASCADE,
  variant_id    uuid   REFERENCES product_variants(id)          ON DELETE CASCADE,  -- NULL → атрибут товара
  attribute_id  uuid   NOT NULL REFERENCES attributes(id)       ON DELETE CASCADE,
  -- Значение: ссылка на словарь (для select) ИЛИ инлайн-значение (text/number/boolean).
  value_id      uuid   REFERENCES attribute_values(id)          ON DELETE RESTRICT,
  value_text    text,                                            -- для type text/number/boolean
  CONSTRAINT product_attributes_value_present
    CHECK (value_id IS NOT NULL OR value_text IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS product_attributes_product_idx ON product_attributes (product_id);
CREATE INDEX IF NOT EXISTS product_attributes_variant_idx ON product_attributes (variant_id);
CREATE INDEX IF NOT EXISTS product_attributes_attr_idx    ON product_attributes (attribute_id);
-- Фасетная фильтрация «товары с значением X»:
CREATE INDEX IF NOT EXISTS product_attributes_value_idx   ON product_attributes (attribute_id, value_id);
-- Один атрибут на уровне товара не дублируется (для не-вариантных):
CREATE UNIQUE INDEX IF NOT EXISTS product_attributes_uniq
  ON product_attributes (product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), attribute_id, COALESCE(value_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- GRANT для рантайма (§2): app выполняет полный DML на справочнике и привязках.
GRANT SELECT, INSERT, UPDATE, DELETE ON attributes         TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON attribute_values   TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_attributes TO admik_app;

-- Запись истории применения этой миграции.
INSERT INTO schema_migrations (version, name)
VALUES ('0008', 'catalog_attributes')
ON CONFLICT DO NOTHING;
