-- =============================================================================
-- 0055_i18n_translations_camel_keys.sql  (T1 — оживление мёртвых SEO-переводов)
-- =============================================================================
-- ДЕФЕКТ ДАННЫХ (не схемы). ETL прошлых сессий писал в jsonb-оверлей translations
-- ключи в snake_case (seo_title / seo_description / og_title / og_description),
-- тогда как единый whitelist переводимых полей (lib/i18n/fields.ts) и весь
-- read/write-path приложения работают с camelCase (seoTitle / seoDescription /
-- ogTitle / ogDescription). Переводы физически лежат в БД, но невидимы: вкладка
-- EN в админке пуста, страница /en отдаёт русский meta description.
-- Замер на демо-стенде (products): en seo_title 255 / seo_description 258,
-- fr seo_title 257 / seo_description 260; ключей 'seoTitle' — 0 (смешанного
-- состояния нет). Прочие таблицы с колонкой translations на стенде чисты, но
-- миграция обходит их все — платформа мультитенантна, у другого магазина залив
-- мог задеть что угодно.
--
-- ЭТО DATA-МИГРАЦИЯ: ни одной DDL-инструкции, только UPDATE значений jsonb.
-- Схема не меняется вовсе, поэтому обратная совместимость (§6.4/ADR-015) не
-- нарушается: старый код читал эти ключи мимо whitelist и всё равно их не видел.
--
-- ПРИОРИТЕТ ПРИ КОЛЛИЗИИ (в одном языке есть и seo_title, и seoTitle): побеждает
-- camelCase. Он единственный, который приложение умеет и читать, и писать, значит
-- значение под ним могло появиться только из живого write-path — ручной правки
-- владельца в админке; snake_case же заведомо машинный залив ETL. Ручная правка
-- не должна проигрывать импорту. ДАННЫЕ НЕ ТЕРЯЮТСЯ: в коллизии snake_case-ключ
-- остаётся на месте нетронутым (whitelist его игнорирует, но он доступен глазами).
--
-- ИДЕМПОТЕНТНОСТЬ: перенос выполняется только когда camelCase-ключа ещё нет;
-- WHERE-предикат отбирает лишь такие строки. Повторный накат — no-op.
--
-- Зеркало этой семантики в коде — чистая функция normalizeLegacyTranslationKeys
-- (lib/i18n/legacy-keys.ts), покрытая юнитами tests/i18n/legacy-keys.test.ts.
--
-- БЭКАП ПЕРЕД НАКАТОМ (миграция необратима) и SQL-проверка результата — в отчёте
-- координатору.
-- =============================================================================

DO $migrate_0055$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'products',
    'product_variants',
    'product_blocks',
    'brands',
    'categories',
    'designers',
    'attributes',
    'attribute_values',
    'cms_pages',
    'cms_page_sections',
    'news',
    'reviews',
    'promo_codes',
    'gift_certificates'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Таблицы отсутствующих модулей молча пропускаем (модульная платформа).
    CONTINUE WHEN to_regclass('public.' || quote_ident(tbl)) IS NULL;

    EXECUTE format($fmt$
      UPDATE %1$I AS t
      SET translations = (
        SELECT jsonb_object_agg(
          loc.key,
          CASE WHEN jsonb_typeof(loc.value) = 'object' THEN (
            SELECT coalesce(
              jsonb_object_agg(
                CASE
                  WHEN m.camel IS NOT NULL AND NOT (loc.value ? m.camel) THEN m.camel
                  ELSE f.key
                END,
                f.value
              ),
              '{}'::jsonb
            )
            FROM jsonb_each(loc.value) AS f
            LEFT JOIN (VALUES
              ('seo_title', 'seoTitle'),
              ('seo_description', 'seoDescription'),
              ('og_title', 'ogTitle'),
              ('og_description', 'ogDescription')
            ) AS m(snake, camel) ON m.snake = f.key
          ) ELSE loc.value END
        )
        FROM jsonb_each(t.translations) AS loc
      )
      WHERE t.translations IS NOT NULL
        AND jsonb_typeof(t.translations) = 'object'
        AND EXISTS (
          SELECT 1
          FROM jsonb_each(t.translations) AS loc
          JOIN (VALUES
            ('seo_title', 'seoTitle'),
            ('seo_description', 'seoDescription'),
            ('og_title', 'ogTitle'),
            ('og_description', 'ogDescription')
          ) AS m(snake, camel) ON loc.value ? m.snake
          WHERE jsonb_typeof(loc.value) = 'object'
            AND NOT (loc.value ? m.camel)
        )
    $fmt$, tbl);
  END LOOP;
END
$migrate_0055$;

INSERT INTO schema_migrations (version, name)
VALUES ('0055', 'i18n_translations_camel_keys')
ON CONFLICT DO NOTHING;
