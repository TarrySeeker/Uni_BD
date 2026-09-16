/**
 * Конфигурация модуля payments/atol (по образцу lib/payments/ozon/config.ts).
 *
 * КЛЮЧЕВОЕ: isAtolMock() — true, когда не задан боевой токен. В mock-режиме
 * клиент НЕ ходит в сеть.
 *
 * ⚠️ УРОК СВформы/DAV: mock не падает и не ругается — магазин выглядит рабочим,
 * а оплата ненастоящая. Поэтому mock-режим обязан быть виден в «Готовности
 * магазина» и в логах, а не обнаруживаться по пустой таблице платежей.
 *
 * 🔴 ОТЛИЧИЕ ОТ Т-БАНКА И ОЗОНА: у callback АТОЛа НЕТ ПОДПИСИ (ни HMAC, ни
 * секрета уведомлений). Единственный канал аутентификации вебхука, который
 * даёт API, — произвольный query-параметр в notificationUrl. Отсюда
 * ATOL_PAY_NOTIFICATION_SECRET: без него вебхуки принимать нельзя.
 */

/** Боевой контур. */
export const ATOL_DEFAULT_BASE_URL = 'https://new-api-mobile.atolpay.ru/v1/ecom/';
/** Песочница (доступ в тестовый ЛК — по запросу на 1@atol.ru). */
export const ATOL_SANDBOX_BASE_URL = 'https://croc-sandbox-api-mobile.atolpay.ru/v1/ecom/';

/**
 * Минимальная длина секрета вебхука. Сверка идёт по ОТКРЫТОМУ URL (секрет
 * попадает в логи прокси), поэтому короткий секрет здесь опаснее явно
 * отсутствующего: он создаёт видимость защиты.
 */
export const MIN_NOTIFICATION_SECRET_LEN = 24;

export interface AtolConfig {
  baseUrl: string;
  /** Токен из ЛК АТОЛ Pay (Настройки → API Токены, показывается один раз). */
  token: string | null;
  /** Секрет для query-параметра notificationUrl — замена отсутствующей подписи. */
  notificationSecret: string | null;

  /** oneStep — списание сразу; twoStep — холд с последующим deposit. */
  sessionType: 'oneStep' | 'twoStep';

  /**
   * Система налогообложения магазина (id словаря АТОЛа).
   * 🔴 null, если не задана: молчаливый дефолт = чек с неверной СНО = 54-ФЗ.
   */
  sno: number | null;
  /**
   * Ставка НДС позиций по умолчанию (id словаря).
   * 🔴 Ловушка: «Без НДС» = 5, а 0 = НДС 20%. Дефолта нет намеренно.
   */
  defaultTax: number | null;

  /** Признак способа расчёта (0 = предоплата 100% — оплата до отгрузки). */
  paymentMethodSubject: number;
  /** Признак предмета расчёта для товара (0 = товар). */
  productSubject: number;
  /** Признак предмета расчёта для доставки (3 = услуга). */
  deliverySubject: number;

  returnUrl: string | null;
  notificationUrl: string | null;

  /** id банка для карт (600 = Т-Банк). null → берётся из настроек ЛК. */
  cardBankId: number | null;
  /** id банка для СБП (400 = Сбербанк). null → берётся из настроек ЛК. */
  sbpBankId: number | null;
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
}

function boolEnv(v: string | undefined, dflt: boolean): boolean {
  const t = v?.trim().toLowerCase();
  if (t === undefined || t === '') return dflt;
  return t === 'true' || t === '1' || t === 'yes';
}

/**
 * Неотрицательное целое либо null.
 *
 * 🔴 Именно null, а не 0: у АТОЛа ноль — ЗНАЧАЩЕЕ значение в обоих словарях
 * (sno 0 = общая СН, tax 0 = НДС 20%). Сводить «не задано» и «ноль» к одному
 * значению здесь нельзя — это разница между чеком без НДС и чеком с 20%.
 */
function idEnv(v: string | undefined): number | null {
  const t = v?.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function intEnv(v: string | undefined, dflt: number): number {
  const n = idEnv(v);
  return n ?? dflt;
}

/** Читает конфигурацию из окружения. source — для тестов без мутации process.env. */
export function getAtolConfig(source?: Record<string, string | undefined>): AtolConfig {
  const env = source ?? process.env;

  const explicitUrl = nonEmpty(env.ATOL_PAY_BASE_URL);
  const sandbox = boolEnv(env.ATOL_PAY_SANDBOX, false);
  const baseUrl = explicitUrl ?? (sandbox ? ATOL_SANDBOX_BASE_URL : ATOL_DEFAULT_BASE_URL);

  const sessionRaw = nonEmpty(env.ATOL_PAY_SESSION_TYPE);
  // Мусор в переменной не имеет права превратить оплату в двухстадийную:
  // при twoStep деньги лишь холдируются, и заказ без deposit не будет оплачен.
  const sessionType = sessionRaw === 'twoStep' ? 'twoStep' : 'oneStep';

  return {
    baseUrl,
    token: nonEmpty(env.ATOL_PAY_TOKEN),
    notificationSecret: nonEmpty(env.ATOL_PAY_NOTIFICATION_SECRET),
    sessionType,

    sno: idEnv(env.ATOL_PAY_SNO),
    defaultTax: idEnv(env.ATOL_PAY_DEFAULT_TAX),

    paymentMethodSubject: intEnv(env.ATOL_PAY_PAYMENT_METHOD, 0),
    productSubject: intEnv(env.ATOL_PAY_PRODUCT_SUBJECT, 0),
    deliverySubject: intEnv(env.ATOL_PAY_DELIVERY_SUBJECT, 3),

    returnUrl: nonEmpty(env.ATOL_PAY_RETURN_URL),
    notificationUrl: nonEmpty(env.ATOL_PAY_NOTIFICATION_URL),

    cardBankId: idEnv(env.ATOL_PAY_CARD_BANK_ID),
    sbpBankId: idEnv(env.ATOL_PAY_SBP_BANK_ID),
  };
}

/** Боевой токен не задан → работаем в mock-режиме, в сеть не ходим. */
export function isAtolMock(source?: Record<string, string | undefined>): boolean {
  return getAtolConfig(source).token === null;
}

/**
 * Можно ли проверять входящие callback.
 *
 * 🔴 Подписи у callback нет, поэтому проверка сводится к секрету в query.
 * Без секрета (или со слабым) вебхуки отвергаются целиком: иначе кто угодно,
 * узнав URL, объявит неоплаченный заказ оплаченным.
 */
export function canVerifyAtolCallbacks(source?: Record<string, string | undefined>): boolean {
  const secret = getAtolConfig(source).notificationSecret;
  return secret !== null && secret.length >= MIN_NOTIFICATION_SECRET_LEN;
}

/** Человекочитаемая диагностика конфигурации — для «Готовности магазина». */
export function atolConfigProblems(source?: Record<string, string | undefined>): string[] {
  const cfg = getAtolConfig(source);
  const problems: string[] = [];

  if (cfg.token === null) {
    problems.push('ATOL_PAY_TOKEN не задан — оплата эмулируется (mock), деньги не списываются');
  }

  if (cfg.notificationSecret === null) {
    problems.push(
      'ATOL_PAY_NOTIFICATION_SECRET не задан — у callback АТОЛа нет подписи, ' +
        'проверить отправителя нечем: вебхуки будут отвергаться',
    );
  } else if (cfg.notificationSecret.length < MIN_NOTIFICATION_SECRET_LEN) {
    problems.push(
      `ATOL_PAY_NOTIFICATION_SECRET короче ${MIN_NOTIFICATION_SECRET_LEN} символов — ` +
        'секрет идёт в открытом URL и должен быть неперебираемым',
    );
  }

  // 🔴 Оба реквизита уходят в КАЖДЫЙ чек. Без них фискализацию включать нельзя.
  if (cfg.sno === null) {
    problems.push(
      'ATOL_PAY_SNO не задана — система налогообложения магазина обязательна в чеке (54-ФЗ)',
    );
  }
  if (cfg.defaultTax === null) {
    problems.push(
      'ATOL_PAY_DEFAULT_TAX не задана — ставка НДС позиций обязательна в чеке ' +
        '(«Без НДС» = 5; внимание: 0 означает НДС 20%)',
    );
  }

  return problems;
}
