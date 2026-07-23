-- =============================================================================
-- 0054_gift_certificates_people.sql  (ТЗ владельца п.7 — «кто купил / на чьё имя»)
-- Аддитивное расширение gift_certificates: стороны сделки (покупатель/получатель)
-- и происхождение выпуска (по какому заказу/позиции и каким способом выпущен код).
--
-- ПОЧЕМУ СНИМКИ (текст), А НЕ ТОЛЬКО ССЫЛКА НА customers (ADR-010, как order_items):
--   1) покупатель может быть ГОСТЕМ без аккаунта — customers.id для него нет
--      (orders.customer_id заполняется только из серверной сессии);
--   2) получатель («на чьё имя») вообще не обязан быть клиентом магазина;
--   3) снимок не должен «переезжать» при правке карточки покупателя: сертификат —
--      документ, на нём зафиксировано, кто и на кого его оформил В МОМЕНТ выпуска.
--   Ссылка purchaser_customer_id добавлена ДОПОЛНИТЕЛЬНО (ON DELETE SET NULL) —
--   только для навигации/аналитики, источник правды для отображения — снимки.
--   email — citext (как customers.email/gift_certificates.code): поиск «кто купил»
--   регистронезависим.
--
-- ПРОИСХОЖДЕНИЕ ВЫПУСКА (issued_order_id / issued_order_item_id):
--   ⚠️ orders.gift_certificate_id (0041) означает ПРОТИВОПОЛОЖНОЕ — «сертификат
--   ПОТРАЧЕН на этот заказ». Переиспользовать его под «выпущен по заказу» нельзя:
--   одно поле получило бы два смысла и денежный конвейер (redeem/release) начал бы
--   конфликтовать с автовыпуском. Поэтому происхождение живёт на стороне
--   сертификата, отдельными полями. Обе ссылки ON DELETE SET NULL — сертификат
--   переживает удаление заказа (деньги уже выпущены, код действует).
--
-- ИСТОЧНИК ВЫПУСКА — text + CHECK, НЕ postgres ENUM: добавление значения в ENUM
--   (ALTER TYPE ... ADD VALUE) неаддитивно по политике §6.4/ADR-015, а расширение
--   CHECK возможно только парой DROP+ADD под owner-signed маркером. Сразу
--   закладываем полный набор, включая ещё не реализованный автовыпуск:
--     'manual' — заведён руками в админке (поведение до этой миграции);
--     'order'  — выпущен админом по позиции оплаченного заказа;
--     'auto'   — выпущен автоматически (волна 4: вебхук оплаты).
--   NULL допустим — это 2 существующие строки стенда, выпущенные до миграции.
--
-- ИДЕМПОТЕНТНОСТЬ АВТОВЫПУСКА (волна 4): ЧАСТИЧНЫЙ UNIQUE по issued_order_item_id
--   WHERE NOT NULL. Повторный вебхук оплаты/повторное нажатие кнопки не создаёт
--   второй код на ту же позицию заказа (нарушение UNIQUE → доменная ошибка).
--   Частичный — потому что «выпущенных вручную» (NULL) может быть сколько угодно.
--
-- Аддитивно: все колонки NULL-able (существующие строки не ломаются), ADD COLUMN
-- IF NOT EXISTS, CHECK/FK через DO-блок по pg_constraint, индексы IF NOT EXISTS.
-- Табличный GRANT из 0039 автоматически покрывает новые колонки.
-- =============================================================================

-- ---- Покупатель («кто купил») — снимок + опциональная ссылка на клиента ----
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS purchaser_name        text;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS purchaser_email       citext;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS purchaser_phone       text;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS purchaser_customer_id uuid;

-- ---- Получатель («на чьё имя») — только снимок (может не быть клиентом) ----
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS recipient_name  text;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS recipient_email citext;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS recipient_phone text;

-- ---- Происхождение выпуска ----
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS issued_order_id      uuid;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS issued_order_item_id uuid;
ALTER TABLE gift_certificates ADD COLUMN IF NOT EXISTS issue_source         text;

DO $$
BEGIN
  -- Источник выпуска: text + CHECK (НЕ enum — расширение множества значений
  -- в волне 4 не потребует неаддитивного ALTER TYPE ... ADD VALUE).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_certificates_issue_source_chk'
  ) THEN
    ALTER TABLE gift_certificates
      ADD CONSTRAINT gift_certificates_issue_source_chk
      CHECK (issue_source IS NULL OR issue_source IN ('manual','order','auto'));
  END IF;

  -- Ссылка на клиента-покупателя (навигация). SET NULL — сертификат переживает
  -- удаление учётки клиента, снимок покупателя остаётся в текстовых колонках.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_certificates_purchaser_customer_fkey'
  ) THEN
    ALTER TABLE gift_certificates
      ADD CONSTRAINT gift_certificates_purchaser_customer_fkey
      FOREIGN KEY (purchaser_customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;

  -- Заказ-источник выпуска (НЕ заказ, на который сертификат потрачен — см. шапку).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_certificates_issued_order_fkey'
  ) THEN
    ALTER TABLE gift_certificates
      ADD CONSTRAINT gift_certificates_issued_order_fkey
      FOREIGN KEY (issued_order_id) REFERENCES orders(id) ON DELETE SET NULL;
  END IF;

  -- Позиция заказа-источника: номинал берётся из её ценового снимка.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_certificates_issued_order_item_fkey'
  ) THEN
    ALTER TABLE gift_certificates
      ADD CONSTRAINT gift_certificates_issued_order_item_fkey
      FOREIGN KEY (issued_order_item_id) REFERENCES order_items(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Идемпотентность выпуска: не более ОДНОГО сертификата на позицию заказа.
-- Частичный (WHERE ... IS NOT NULL) — ручные выпуски (NULL) не конфликтуют.
CREATE UNIQUE INDEX IF NOT EXISTS gift_certificates_issued_item_uniq
  ON gift_certificates (issued_order_item_id)
  WHERE issued_order_item_id IS NOT NULL;

-- Блок «сертификаты по заказу» в карточке заказа.
CREATE INDEX IF NOT EXISTS gift_certificates_issued_order_idx
  ON gift_certificates (issued_order_id)
  WHERE issued_order_id IS NOT NULL;

-- Поиск «кто купил» в админке (citext → регистронезависимо).
CREATE INDEX IF NOT EXISTS gift_certificates_purchaser_email_idx
  ON gift_certificates (purchaser_email)
  WHERE purchaser_email IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES ('0054', 'gift_certificates_people')
ON CONFLICT DO NOTHING;
