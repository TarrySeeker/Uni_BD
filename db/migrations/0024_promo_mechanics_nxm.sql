-- =============================================================================
-- 0024_promo_mechanics_nxm.sql  (Этап 5 — модуль orders, Пакет 5.P-1)
-- Промо-механики «N по M» (docs/11 §5.2). Аддитивно к 0014_promo_codes:
--   * новые колонки promo_codes (apply_scope/priority/stackable/min_qty/gift_*),
--   * CHECK promo_bogo_pair_chk (kind='bogo' ⇒ bogo-пара задана и pay < buy),
--   * новая таблица promo_targets — таргеты scope/N×M (категория/бренд/товар/вариант).
--
-- Без backfill: DEFAULT покрывают существующие строки. Gift-* — ЗАДЕЛ (исполнение
--   отложено), FK ON DELETE SET NULL. promo_targets FK к каталогу ON DELETE CASCADE.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF NOT EXISTS,
--   DO-блок (pg_constraint) для FK/CHECK, ON CONFLICT DO NOTHING.
-- =============================================================================

-- ---- Новые колонки promo_codes (аддитивно, идемпотентно) --------------------
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS apply_scope     text    NOT NULL DEFAULT 'cart'
                          CHECK (apply_scope IN ('cart','category','brand','set'));
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS priority        integer NOT NULL DEFAULT 100
                          CHECK (priority >= 0);
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS stackable       boolean NOT NULL DEFAULT false;
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS min_qty         integer CHECK (min_qty IS NULL OR min_qty > 0);
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS gift_product_id uuid;
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS gift_variant_id uuid;
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS gift_qty        integer CHECK (gift_qty IS NULL OR gift_qty > 0);

-- FK gift_product_id → products(id) ON DELETE SET NULL (задел; идемпотентно):
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_gift_product_id_fkey'
  ) THEN
    ALTER TABLE promo_codes
      ADD CONSTRAINT promo_codes_gift_product_id_fkey
      FOREIGN KEY (gift_product_id) REFERENCES products(id) ON DELETE SET NULL;
  END IF;
END $$;

-- FK gift_variant_id → product_variants(id) ON DELETE SET NULL (задел; идемпотентно):
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_gift_variant_id_fkey'
  ) THEN
    ALTER TABLE promo_codes
      ADD CONSTRAINT promo_codes_gift_variant_id_fkey
      FOREIGN KEY (gift_variant_id) REFERENCES product_variants(id) ON DELETE SET NULL;
  END IF;
END $$;

-- CHECK promo_bogo_pair_chk: kind='bogo' ⇒ пара задана и bogo_pay_qty < bogo_buy_qty
-- (для остальных kind — ограничение неактивно). Идемпотентно через pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promo_bogo_pair_chk'
  ) THEN
    ALTER TABLE promo_codes
      ADD CONSTRAINT promo_bogo_pair_chk CHECK (
        kind <> 'bogo'
        OR (
          bogo_buy_qty IS NOT NULL
          AND bogo_pay_qty IS NOT NULL
          AND bogo_pay_qty < bogo_buy_qty
        )
      );
  END IF;
END $$;

-- ---- promo_targets — таргеты scope/N×M-группировки --------------------------
CREATE TABLE IF NOT EXISTS promo_targets (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id uuid        NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,

  -- Тип таргета — дискриминатор: ровно одна из *_id заполнена (CHECK ниже).
  target_type   text        NOT NULL
                CHECK (target_type IN ('category','brand','product','variant')),

  category_id   uuid        REFERENCES categories(id)        ON DELETE CASCADE,
  brand_id      uuid        REFERENCES brands(id)            ON DELETE CASCADE,
  product_id    uuid        REFERENCES products(id)          ON DELETE CASCADE,
  variant_id    uuid        REFERENCES product_variants(id)  ON DELETE CASCADE,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Ровно одна *_id заполнена соответственно target_type:
  CONSTRAINT promo_targets_kind_chk CHECK (
    (target_type = 'category' AND category_id IS NOT NULL
       AND brand_id IS NULL AND product_id IS NULL AND variant_id IS NULL)
    OR (target_type = 'brand' AND brand_id IS NOT NULL
       AND category_id IS NULL AND product_id IS NULL AND variant_id IS NULL)
    OR (target_type = 'product' AND product_id IS NOT NULL
       AND category_id IS NULL AND brand_id IS NULL AND variant_id IS NULL)
    OR (target_type = 'variant' AND variant_id IS NOT NULL
       AND category_id IS NULL AND brand_id IS NULL AND product_id IS NULL)
  )
);

-- Не дублировать один и тот же таргет в рамках одной акции:
CREATE UNIQUE INDEX IF NOT EXISTS promo_targets_uniq
  ON promo_targets (
    promo_code_id,
    target_type,
    COALESCE(category_id, brand_id, product_id, variant_id)
  );
CREATE INDEX IF NOT EXISTS promo_targets_promo_idx ON promo_targets (promo_code_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON promo_targets TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0024', 'promo_mechanics_nxm')
ON CONFLICT DO NOTHING;
