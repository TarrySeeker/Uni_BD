/**
 * Сбор фактов для экрана «Готовность магазина» (I/O-слой).
 *
 * Разделение намеренное: вся ЛОГИКА вердиктов живёт в чистом `readiness.ts` и
 * покрыта тестами без БД; здесь — только чтение фактов (настройки, `.env`,
 * счётчики каталога). Так проверяемая часть не зависит от наличия стенда.
 *
 * УСТОЙЧИВОСТЬ. Каждый счётчик читается изолированно, и при ошибке возвращается
 * `null` — «не удалось установить», а НЕ 0. Разница принципиальна: экран,
 * который при сбое запроса показывает «0 товаров без цены», врёт владельцу
 * ровно там, где должен предупреждать. Молчаливое проглатывание ошибки БД уже
 * однажды скрыло реальный дефект на дашборде.
 */

import { sql } from '@/lib/db/client';
import { getEnv } from '@/lib/config/env';
import { getEffectiveSettings, isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { isCdekMock } from '@/lib/cdek/config';
import { isTbankMock } from '@/lib/payments/tbank/config';

import type { ReadinessInput } from './readiness';

/** Безопасный COUNT: любая ошибка → null («не смогли посчитать»), не 0. */
async function safeCount(run: () => Promise<{ n: string }[]>): Promise<number | null> {
  try {
    const rows = await run();
    const n = Number(rows[0]?.n ?? 0);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Похоже ли на тестовые данные. Ищем в НАЗВАНИИ и артикуле распространённые
 * маркеры (`test`, `тест`, префикс `zz-`), которыми помечают пробные позиции.
 *
 * Эвристика намеренно узкая: лучше не заметить тестовый товар, чем обвинить
 * настоящий. Пункт отчёта — предупреждение, а не блокер, и формулируется как
 * «похоже на тестовые», а не «тестовые».
 */
const TEST_LIKE_SQL_PATTERN = '%test%';

/**
 * Читает снимок фактов об инстансе. Ошибки отдельных проверок не роняют сбор:
 * непрочитанный факт становится `null`/`false`, а не исключением — экран
 * диагностики обязан открываться даже на сломанном магазине (иначе он бесполезен
 * ровно тогда, когда нужнее всего).
 */
export async function collectReadinessInput(): Promise<ReadinessInput> {
  const env = getEnv();

  const [cdekOn, paymentsOn, catalogOn, ordersOn, accountOn] = await Promise.all([
    isModuleEffectivelyEnabled('cdek').catch(() => false),
    isModuleEffectivelyEnabled('payments').catch(() => false),
    isModuleEffectivelyEnabled('catalog').catch(() => false),
    isModuleEffectivelyEnabled('orders').catch(() => false),
    isModuleEffectivelyEnabled('account').catch(() => false),
  ]);

  // Настройки читаем мягко: при недоступности БД экран всё равно должен
  // показать то, что видно из .env (ключи, секреты).
  const settings = await getEffectiveSettings().catch(() => null);

  const siteUrl = settings?.seo?.site_url ?? null;
  const shopNameSet = Boolean(settings?.branding?.shopName);
  const contactsSet = Boolean(settings?.contacts?.phone || settings?.contacts?.email);

  // --- Счётчики каталога -----------------------------------------------------
  // Считаем ТОЛЬКО по опубликованным товарам: черновик без цены — нормальная
  // рабочая ситуация, а не проблема. Проблема — когда покупатель видит товар,
  // который нельзя купить.
  const [activeProducts, withoutPrice, withoutImage, testLike] = catalogOn
    ? await Promise.all([
        safeCount(
          () => sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM products WHERE status = 'active'
          `,
        ),
        safeCount(
          () => sql<{ n: string }[]>`
            SELECT count(*)::text AS n
              FROM products
             WHERE status = 'active'
               AND (base_price IS NULL OR base_price <= 0)
          `,
        ),
        safeCount(
          () => sql<{ n: string }[]>`
            SELECT count(*)::text AS n
              FROM products p
             WHERE p.status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM product_media m WHERE m.product_id = p.id
               )
          `,
        ),
        safeCount(
          () => sql<{ n: string }[]>`
            SELECT count(*)::text AS n
              FROM products
             WHERE status = 'active'
               AND (
                 lower(name) LIKE ${TEST_LIKE_SQL_PATTERN}
                 OR lower(name) LIKE ${'%тест%'}
                 OR lower(sku::text) LIKE ${'zz-%'}
               )
          `,
        ),
      ])
    : [null, null, null, null];

  // --- Правовые документы ----------------------------------------------------
  // Опубликованные CMS-страницы: сравниваем со списком обязательных в readiness.
  // При сбое запроса — null («не смогли проверить»), а НЕ пустой массив: иначе
  // недоступность БД выглядела бы как «документов нет» и давала ложный блокер.
  const publishedDocs = await sql<{ slug: string }[]>`
    SELECT slug FROM cms_pages WHERE status = 'published'
  `
    .then((rows) => rows.map((r) => r.slug))
    .catch(() => null);

  // Ст.9 ЗоЗПП: покупателю раскрывают наименование продавца и сведения о его
  // регистрации. Минимум, который проверяем машинно, — наименование и ИНН.
  const legalEntitySet = Boolean(
    settings?.legalEntity?.name && settings?.legalEntity?.inn,
  );

  return {
    modules: {
      cdek: cdekOn,
      payments: paymentsOn,
      catalog: catalogOn,
      orders: ordersOn,
      account: accountOn,
    },
    integrations: {
      cdekMock: isCdekMock(),
      cdekCronSecretSet: Boolean(env.CDEK_CRON_SECRET && env.CDEK_CRON_SECRET.length > 0),
      paymentsMock: isTbankMock(),
      storageConfigured: Boolean(env.S3_ENDPOINT && env.S3_BUCKET),
      // Тот же минимум, что и в самом почтовом модуле: без адреса отправителя
      // письмо не примет ни один сервер, поэтому половина настройки не считается.
      mailConfigured: Boolean(env.SMTP_HOST && env.MAIL_FROM),
    },
    site: { siteUrl, shopNameSet, contactsSet },
    catalog: { activeProducts, withoutPrice, withoutImage, testLike },
    legal: { publishedDocs, legalEntitySet },
  };
}
