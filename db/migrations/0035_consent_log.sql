-- =============================================================================
-- 0035_consent_log.sql — журнал согласий субъекта персональных данных (152-ФЗ)
--
-- Зачем. Любая форма магазина, собирающая имя, телефон или почту, — это сбор
-- персональных данных, и по ч.1 ст.9 152-ФЗ наличие согласия доказывает
-- ОПЕРАТОР. Отрисованная галочка не доказывает ничего: её нет ни в базе, ни в
-- логах. Поэтому факт согласия не только проверяется на сервере, но и пишется
-- сюда — вместе с ТЕКСТОМ формулировки и её версией: согласие оценивается по
-- редакции, действовавшей на момент, когда его дали.
--
-- ФЗ-156 от 24.06.2025 (действует с 01.09.2025) требует, чтобы согласие на
-- обработку ПДн оформлялось ОТДЕЛЬНО от иных информации и документов. Отсюда
-- раздельные виды (`purpose`), а не одна строка «со всем согласен».
--
-- APPEND-ONLY НА УРОВНЕ БД. В GRANT ниже намеренно нет UPDATE и DELETE: журнал,
-- который можно задним числом поправить, доказательной силы не имеет. Роль
-- приложения может только вставлять и читать — ошибка в коде не сможет стереть
-- согласие даже случайно.
--
-- Идемпотентно/аддитивно: CREATE TABLE/INDEX IF NOT EXISTS, GRANT повторно
-- безопасен, запись в журнал миграций — ON CONFLICT DO NOTHING.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consent_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Вид согласия: 'pd' (обработка ПДн), 'offer' (акцепт оферты),
  -- 'marketing' (реклама), 'age' (возрастное — для ниш, где оно требуется).
  -- CHECK намеренно НЕ ограничивает список: новый вид согласия не должен
  -- требовать миграции, а старый код продолжит писать свои значения.
  purpose         text        NOT NULL CHECK (length(purpose) BETWEEN 1 AND 40),

  -- Где дано: 'order' | 'lead' | 'newsletter' | …
  source          text        NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  -- Номер заказа / id заявки, если объект уже создан.
  source_ref      text        CHECK (source_ref IS NULL OR length(source_ref) <= 100),

  -- Контакт субъекта (email или телефон) — по нему ищут согласие при отзыве.
  subject         text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 320),

  -- Формулировка и её редакция на момент дачи согласия.
  consent_text    text        NOT NULL CHECK (length(consent_text) BETWEEN 1 AND 4000),
  consent_version text        NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 40),

  -- Обстоятельства. ip — inet, как в audit_log; невалидный адрес пишется как
  -- NULL (нормализацией занимается lib/server/request-ip).
  ip              inet,
  user_agent      text        CHECK (user_agent IS NULL OR length(user_agent) <= 1000),

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Поиск согласий субъекта при отзыве и при проверке — основной сценарий чтения.
CREATE INDEX IF NOT EXISTS consent_log_subject_idx  ON consent_log (subject, created_at DESC);
-- Выборка по объекту: «какие согласия дал покупатель по этому заказу».
CREATE INDEX IF NOT EXISTS consent_log_source_idx   ON consent_log (source, source_ref);

-- Append-only: INSERT и SELECT, без UPDATE/DELETE (см. шапку).
GRANT SELECT, INSERT ON consent_log TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0035', 'consent_log')
ON CONFLICT DO NOTHING;
