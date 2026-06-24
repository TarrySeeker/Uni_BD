import { z } from 'zod';

/**
 * Типобезопасное чтение переменных окружения через Zod.
 *
 * На этапе 0 в коде ещё нет обращений к БД/S3/Redis, поэтому большинство
 * переменных опциональны — это позволяет запускать скаффолд и проходить
 * проверки без полной конфигурации. По мере появления модулей переменные
 * будут становиться обязательными.
 */

/**
 * Опциональный URL. ВАЖНО: пустая строка (`ALERT_WEBHOOK_URL=` и т.п. — частый
 * случай в .env) трактуется как «не задано», иначе `.url()` падал бы с «Invalid
 * URL» и ронял запуск приложения. Непустое значение валидируется как URL.
 */
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().url().optional(),
);

const envSchema = z.object({
  // Окружение Node.
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  // Подключение к БД (обязательно появится на этапе работы с данными).
  DATABASE_URL: optionalUrl,

  // Seed владельца магазина (docs/04 §4.2). Используются init-shop при первом
  // развёртывании: создаётся учётка владельца (is_owner). Если OWNER_PASSWORD
  // не задан — owner.mjs генерирует случайный пароль и печатает его один раз.
  // OWNER_EMAIL — это ЛОГИН владельца: произвольная строка (напр. `admin`) ИЛИ
  // email. Формат не ограничиваем (вход в админку принимает логин-или-email).
  OWNER_EMAIL: z.string().trim().min(1).optional(),
  OWNER_PASSWORD: z.string().optional(),

  // Пароли ролей БД (ADR-002/ADR-006, §3.4). Передаются в psql при накате
  // миграций (admik_app — рантайм, admik_migrator — DDL). В репозитории нет.
  APP_PASSWORD: z.string().optional(),
  MIGRATOR_PASSWORD: z.string().optional(),

  // Выделенный секрет HMAC токена доступа к заказу (m10). Если не задан — фолбэк на
  // APP_PASSWORD/OWNER_PASSWORD; в production без какого-либо секрета токены небезопасны
  // (orderTokenSecret бросает — fail-closed). Развязывает токен заказа от пароля админки.
  ORDER_TOKEN_SECRET: z.string().optional(),

  // Кеш / rate-limit.
  REDIS_URL: optionalUrl,

  // ---------------------------------------------------------------------------
  // Логирование и мониторинг (Этап 6, пакет 6.3; lib/logger.ts; ADR-015 §6.3).
  // ---------------------------------------------------------------------------
  // Минимальный уровень логов приложения (debug<info<warn<error). Дефолт info.
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Человекочитаемый вывод логов вместо чистого JSON (для dev). Дефолт false.
  LOG_PRETTY: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Webhook для алертов (Telegram/Slack incoming webhook). Пусто → алерты только
  // в лог (graceful degradation). Читается healthcheck-monitor.sh; в env.ts —
  // для единообразия конфигурации/документирования.
  ALERT_WEBHOOK_URL: optionalUrl,

  // S3-совместимое хранилище медиа.
  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_PUBLIC_URL: optionalUrl,

  // Набор включённых модулей (csv). Парсится в modules.ts.
  ADMIK_MODULES: z.string().optional(),

  // Брендинг магазина.
  SHOP_NAME: z.string().optional(),
  SHOP_LOGO_URL: optionalUrl,

  // Каталог: валюта магазина (docs/06 §3.5) — форматирование цен в слое
  // представления/Storefront API; в данных каталога цены без символа валюты.
  SHOP_CURRENCY: z.string().min(1).default('RUB'),
  // Порог «новизны» товара в днях (docs/06 §3.2): если products.is_new IS NULL,
  // товар «новый», пока created_at в пределах SHOP_NEW_PRODUCT_DAYS. coerce — из строки env.
  SHOP_NEW_PRODUCT_DAYS: z.coerce.number().int().min(0).default(30),

  // Заказы (Этап 3, docs/07 §3.3, §8 пакет F) — без хардкодов магазина:
  // Порог бесплатной доставки. Если (items_total − discount_total) ≥ порога →
  // delivery_total = 0. По умолчанию 0 = выключено (для Gang Auto = 3000).
  // coerce — из строки env.
  SHOP_FREE_DELIVERY_THRESHOLD: z.coerce.number().min(0).default(0),
  // Префикс человекочитаемого номера заказа (docs/07 §2.7): `ПРЕФИКС-ГОД-NNNNNN`.
  // По умолчанию пусто (номер вида `2026-000123`); для магазина задаётся в env.
  SHOP_ORDER_PREFIX: z.string().default(''),

  // ---------------------------------------------------------------------------
  // СДЭК (Этап 4, docs/08 §13.2). ВСЕ переменные опциональны: при пустых
  // CDEK_ACCOUNT/CDEK_SECRET модуль работает в MOCK-режиме (см. lib/cdek/config.ts
  // isCdekMock). Это позволяет demo-магазину и CI работать без боевых ключей.
  // ---------------------------------------------------------------------------
  // Базовый URL API. Prod: https://api.cdek.ru, test-контур: https://api.edu.cdek.ru.
  CDEK_BASE_URL: z.string().url().default('https://api.cdek.ru'),
  // client_id / client_secret. ПУСТО → mock-режим.
  CDEK_ACCOUNT: z.string().optional(),
  CDEK_SECRET: z.string().optional(),
  // Тестовый контур СДЭК. coerce: 'true'/'1'/'false'/'0' из строки env → boolean.
  CDEK_TEST_MODE: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Код города отправления (дефолт 44 = Москва). Взаимоисключим с CDEK_SHIPMENT_POINT.
  CDEK_FROM_LOCATION_CODE: z.coerce.number().int().min(0).default(44),
  // Код склада отправителя (если задан — используется вместо from_location).
  CDEK_SHIPMENT_POINT: z.string().optional(),
  // Тариф по умолчанию для ПВЗ/постамата (склад-склад, дефолт 136).
  CDEK_DEFAULT_TARIFF: z.coerce.number().int().min(0).default(136),
  // Тариф курьерской доставки «до двери» (склад-дверь, дефолт 137). Раньше
  // курьер тарифицировался ПВЗ-тарифом 136 (склад-склад) — недотариф/ошибка СДЭК.
  CDEK_DOOR_TARIFF: z.coerce.number().int().min(0).default(137),
  // Белый список тарифов (csv); пусто = разрешены все. Парсится в config.ts.
  CDEK_ALLOWED_TARIFFS: z.string().optional(),
  // Отправитель (для buildPayload, пакет D).
  CDEK_SENDER_NAME: z.string().optional(),
  CDEK_SENDER_CONTACT_NAME: z.string().optional(),
  CDEK_SENDER_PHONE: z.string().optional(),
  CDEK_SENDER_EMAIL: z.string().optional(),
  CDEK_SENDER_INN: z.string().optional(),
  // Дефолтные габариты упаковки (аналог cdek-dimensions.php */* fallback).
  CDEK_DEFAULT_WEIGHT_G: z.coerce.number().int().min(0).default(500),
  CDEK_DEFAULT_LENGTH_CM: z.coerce.number().int().min(0).default(30),
  CDEK_DEFAULT_WIDTH_CM: z.coerce.number().int().min(0).default(20),
  CDEK_DEFAULT_HEIGHT_CM: z.coerce.number().int().min(0).default(10),
  // Секрет ?key= для webhook (пакет F).
  CDEK_WEBHOOK_SECRET: z.string().optional(),
  // IP/CIDR whitelist webhook (csv); пусто допустимо лишь в test-режиме.
  CDEK_WEBHOOK_IPS: z.string().optional(),
  // Доверять прокси-заголовку IP (за Caddy).
  CDEK_WEBHOOK_TRUST_PROXY: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Секрет cron-роутов (пакет G).
  CDEK_CRON_SECRET: z.string().optional(),
  // Kill-switch авто-создания отправлений (дефолт true).
  CDEK_CREATE_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  // ---------------------------------------------------------------------------
  // Т-БАНК ИНТЕРНЕТ-ЭКВАЙРИНГ (Этап 7, docs/15 §3). ВСЕ переменные опциональны:
  // при пустых TBANK_TERMINAL_KEY/TBANK_PASSWORD модуль работает в MOCK-режиме
  // (см. lib/payments/tbank/config.ts isTbankMock) — demo/CI без боевого терминала.
  // ---------------------------------------------------------------------------
  // Базовый URL T-API. Боевой: https://securepay.tinkoff.ru/v2,
  // тестовый (sandbox): https://rest-api-test.tinkoff.ru/v2.
  TBANK_BASE_URL: z.string().url().default('https://securepay.tinkoff.ru/v2'),
  // Идентификатор терминала / пароль терминала (подпись Token). ПУСТО → mock.
  TBANK_TERMINAL_KEY: z.string().optional(),
  TBANK_PASSWORD: z.string().optional(),
  // Стадийность: O — одностадийная (списание сразу), T — двухстадийная (hold→Confirm).
  TBANK_PAY_TYPE: z.enum(['O', 'T']).default('O'),
  // Формировать ли чек 54-ФЗ (только если к терминалу подключена онлайн-касса).
  TBANK_RECEIPT_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // СНО магазина для чека (osn|usn_income|usn_income_outcome|esn|patent).
  TBANK_TAXATION: z.string().optional(),
  // Ставка НДС позиции по умолчанию (none|vat0|vat10|vat20|…).
  TBANK_DEFAULT_TAX: z.string().default('none'),
  // Абсолютный URL нашего webhook (Init.NotificationURL); иначе берётся из ЛК.
  TBANK_NOTIFICATION_URL: optionalUrl,
  // Редиректы витрины при успехе/отказе оплаты.
  TBANK_SUCCESS_URL: optionalUrl,
  TBANK_FAIL_URL: optionalUrl,
  // Доп. IP/CIDR whitelist webhook (csv); главная защита — Token. Пусто допустимо.
  TBANK_WEBHOOK_IPS: z.string().optional(),
  // Доверять прокси-заголовку IP (за Caddy).
  TBANK_WEBHOOK_TRUST_PROXY: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Срок жизни ссылки/QR оплаты (минуты) → Init.RedirectDueDate.
  TBANK_REDIRECT_DUE_MIN: z.coerce.number().int().min(1).default(60),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Возвращает провалидированную конфигурацию окружения.
 * Бросает понятную ошибку, если значения некорректны.
 */
export function getEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  if (cached && source === process.env) {
    return cached;
  }

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Некорректная конфигурация окружения (.env):\n${issues}\n` +
        'Проверьте файл .env (см. .env.example).',
    );
  }

  if (source === process.env) {
    cached = parsed.data;
  }

  return parsed.data;
}

/**
 * Сбрасывает кеш конфигурации. Используется в тестах.
 */
export function resetEnvCache(): void {
  cached = undefined;
}
