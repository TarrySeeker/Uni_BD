/**
 * Конфигурация модуля payments/ozon (по образцу lib/payments/tbank/config.ts).
 *
 * КЛЮЧЕВОЕ: isOzonMock() — true, когда не заданы боевые ключи. В mock-режиме
 * клиент НЕ ходит в сеть.
 *
 * ⚠️ УРОК СВформы/DAV: mock не падает и не ругается — магазин выглядит рабочим,
 * а оплата ненастоящая. Поэтому здесь есть assertOzonConfigured(): её вызывает
 * старт приложения, чтобы в ПРОДЕ (не dev/test) молчаливый mock был виден в логах
 * как явное предупреждение, а не обнаруживался по пустой таблице платежей.
 */

const OZON_DEFAULT_BASE_URL = "https://payapi.ozon.ru";

export interface OzonConfig {
  baseUrl: string;
  accessKey: string | null;
  secretKey: string | null;
  notificationSecretKey: string | null;

  /** PAY_ALGO_SMS — одностадийный (списание сразу). */
  payAlgorithm: "PAY_ALGO_SMS" | "PAY_ALGO_DMS";
  /** Фискализация: касса подключена на стороне Ozon → чеки пробивает банк. */
  fiscalizationEnabled: boolean;
  fiscalizationType: "FISCAL_TYPE_SINGLE" | "FISCAL_TYPE_DOUBLE";
  /** Ставка НДС по умолчанию для позиций чека (items.vat). */
  defaultVat: string;

  successUrl: string | null;
  failUrl: string | null;
  notificationUrl: string | null;

  /** Время жизни неоплаченного заказа, мин (→ expiresAt). */
  expiresMin: number;
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
}

function boolEnv(v: string | undefined, dflt: boolean): boolean {
  const t = v?.trim().toLowerCase();
  if (t === undefined || t === "") return dflt;
  return t === "true" || t === "1" || t === "yes";
}

function intEnv(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Читает конфигурацию из окружения. source — для тестов без мутации process.env. */
export function getOzonConfig(source?: Record<string, string | undefined>): OzonConfig {
  const env = source ?? process.env;
  return {
    baseUrl: nonEmpty(env.OZON_PAY_BASE_URL) ?? OZON_DEFAULT_BASE_URL,
    accessKey: nonEmpty(env.OZON_PAY_ACCESS_KEY),
    secretKey: nonEmpty(env.OZON_PAY_SECRET_KEY),
    notificationSecretKey: nonEmpty(env.OZON_PAY_NOTIFICATION_SECRET),

    payAlgorithm: env.OZON_PAY_ALGORITHM === "PAY_ALGO_DMS" ? "PAY_ALGO_DMS" : "PAY_ALGO_SMS",
    fiscalizationEnabled: boolEnv(env.OZON_PAY_FISCALIZATION, true),
    fiscalizationType:
      env.OZON_PAY_FISCAL_TYPE === "FISCAL_TYPE_DOUBLE"
        ? "FISCAL_TYPE_DOUBLE"
        : "FISCAL_TYPE_SINGLE",
    // Дефолт VAT_NONE — режим без НДС (УСН). ⛔ Владелец уточняет ставку;
    // меняется одной переменной, без правок кода.
    defaultVat: nonEmpty(env.OZON_PAY_DEFAULT_VAT) ?? "VAT_NONE",

    successUrl: nonEmpty(env.OZON_PAY_SUCCESS_URL),
    failUrl: nonEmpty(env.OZON_PAY_FAIL_URL),
    notificationUrl: nonEmpty(env.OZON_PAY_NOTIFICATION_URL),

    expiresMin: intEnv(env.OZON_PAY_EXPIRES_MIN, 60),
  };
}

/**
 * MOCK-режим: боевые ключи не заданы. Нужны ОБА — accessKey и secretKey:
 * без любого из них подписать запрос невозможно.
 */
export function isOzonMock(source?: Record<string, string | undefined>): boolean {
  const c = getOzonConfig(source);
  return c.accessKey === null || c.secretKey === null;
}

/**
 * Можно ли проверять подписи входящих уведомлений. Отдельно от isOzonMock:
 * ключ нотификаций — ТРЕТИЙ, независимый секрет. Без него вебхук обязан
 * отвергать все уведомления, а не принимать их без проверки.
 */
export function canVerifyOzonNotifications(source?: Record<string, string | undefined>): boolean {
  return getOzonConfig(source).notificationSecretKey !== null;
}

/** Что именно не настроено — для внятной диагностики вместо «просто не работает». */
export function ozonConfigProblems(source?: Record<string, string | undefined>): string[] {
  const c = getOzonConfig(source);
  const p: string[] = [];
  if (!c.accessKey) p.push("OZON_PAY_ACCESS_KEY не задан (ID токена из ЛК)");
  if (!c.secretKey) p.push("OZON_PAY_SECRET_KEY не задан (секретный ключ)");
  if (!c.notificationSecretKey)
    p.push("OZON_PAY_NOTIFICATION_SECRET не задан — уведомления банка будут отвергаться");
  if (!c.successUrl) p.push("OZON_PAY_SUCCESS_URL не задан (можно задать в настройках токена в ЛК)");
  if (!c.failUrl) p.push("OZON_PAY_FAIL_URL не задан (можно задать в настройках токена в ЛК)");
  return p;
}
