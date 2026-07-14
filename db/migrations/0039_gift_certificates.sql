-- =============================================================================
-- 0039_gift_certificates.sql  (Фаза 1 — под-шаг 4a; docs/24 §5, §10)
-- Подарочные сертификаты-баланс (порт eAdmin b_promocode_sum). В отличие от
-- promo_codes (правило скидки per-order без переносимого баланса) — балансовый
-- инструмент: номинал (initial_amount) списывается ЧАСТИЧНО по нескольким
-- заказам, хранится остаток (remaining = initial_amount − spent_total).
--
-- Инвариант: 0 <= spent_total <= initial_amount; remaining = initial_amount −
-- spent_total. spent_total денормализован и согласован с леджером списаний
-- (0040): spent_total = Σ(amount WHERE reversed_at IS NULL). Транзакционный
-- декремент — guarded UPDATE под FOR UPDATE (анти-TOCTOU, см. lib/gift-certificates).
--
-- i18n (ADR-P1-4, docs/24 §1): description/terms — публичные переводимые поля;
-- база (ru) в колонках, en/fr — в translations jsonb (whitelist description/terms).
-- name/code НЕ переводимы (служебные).
--
-- Идемпотентно/аддитивно (§6.4/ADR-015): CREATE TABLE/INDEX IF NOT EXISTS,
-- CHECK через DO-блок (pg_constraint), schema_migrations ON CONFLICT DO NOTHING.
-- Таблично-уровневый GRANT покрывает будущие аддитивные колонки автоматически.
-- =============================================================================

CREATE TABLE IF NOT EXISTS gift_certificates (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  code            citext        NOT NULL,                              -- регистронезависим, уникален (← b_promocode_sum.code)
  name            text          NOT NULL DEFAULT '',                   -- админ-метка (НЕ переводимо)
  description     text,                                                -- публичное описание (переводимо, i18n-whitelist)
  terms           text,                                                -- условия использования (переводимо, i18n-whitelist)

  -- ---- Баланс (деньги — NUMERIC(14,2), арифметика в копейках в домене) ----
  initial_amount  numeric(14,2) NOT NULL CHECK (initial_amount > 0),   -- номинал (← sum); > 0
  spent_total     numeric(14,2) NOT NULL DEFAULT 0,                    -- потрачено (← sum_spent)
  currency        text          NOT NULL DEFAULT 'RUB',

  -- ---- Жизненный цикл ----
  --   active   — действует, доступен к списанию;
  --   depleted — остаток исчерпан (spent_total == initial_amount), выставляется автоматически;
  --   disabled — отключён вручную (деактивация);
  --   expired  — истёк срок действия (valid_until в прошлом).
  status          text          NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','depleted','disabled','expired')),
  valid_until     timestamptz,                                         -- срок действия (← date_to); NULL = бессрочно

  translations    jsonb         NOT NULL DEFAULT '{}'::jsonb,          -- i18n-оверлей: whitelist description/terms

  comment         text          NOT NULL DEFAULT '',
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),

  -- Инвариант баланса: 0 <= spent_total <= initial_amount (защита от гонок/оверспенда).
  CONSTRAINT gift_certificates_spent_range_chk
    CHECK (spent_total >= 0 AND spent_total <= initial_amount)
);

-- Уникальность кода (регистронезависимо — citext) + быстрый lookup при погашении.
CREATE UNIQUE INDEX IF NOT EXISTS gift_certificates_code_uniq   ON gift_certificates (code);
-- Список активных в админке (partial — только действующие).
CREATE INDEX        IF NOT EXISTS gift_certificates_active_idx  ON gift_certificates (status) WHERE status = 'active';

-- CHECK (jsonb_typeof(translations) = 'object') — оверлей всегда объект (см. 0034/0035).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_certificates_translations_obj_chk'
  ) THEN
    ALTER TABLE gift_certificates
      ADD CONSTRAINT gift_certificates_translations_obj_chk
      CHECK (jsonb_typeof(translations) = 'object');
  END IF;
END $$;

-- Роль приложения: чтение/выпуск/обновление/деактивация. DELETE в UI не
-- предлагается (деактивация вместо удаления), грант присутствует для тест-
-- очистки и симметрии с orders/promo_codes (защита от удаления — на уровне actions).
GRANT SELECT, INSERT, UPDATE, DELETE ON gift_certificates TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0039', 'gift_certificates')
ON CONFLICT DO NOTHING;
