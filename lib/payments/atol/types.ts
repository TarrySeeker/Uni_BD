/**
 * Типы АТОЛ Pay Ecom (интернет-эквайринг). Документация интеграции — docs-atol/.
 *
 * 🔴 ТРИ ЕДИНИЦЫ ИЗМЕРЕНИЯ, КОТОРЫЕ ЛЕГКО ПЕРЕПУТАТЬ:
 *   • amount, price — КОПЕЙКИ (10000 = 100 ₽);
 *   • quantity      — ТЫСЯЧНЫЕ (999000 = 999 шт);
 *   • tax, sno, measure, paymentSubject — числовые id из словарей АТОЛа,
 *     НЕ проценты и не строки (см. docs-atol/03-словари-боевые.md).
 * На той же ловушке с копейками уже горели с Озон Банком.
 */

/** Одностадийная (списание сразу) или двухстадийная (холд + deposit) сессия. */
export type AtolSessionType = 'oneStep' | 'twoStep';

/** Способ оплаты на платёжной форме. */
export type AtolPaymentType = 'card' | 'bank_app' | 'sbp';

/**
 * Числовой статус платежа (`paymentStatus`) — ЕДИНСТВЕННЫЙ достоверный
 * источник факта оплаты.
 *
 * 🔴 Поле `status` в том же теле («success» | «fail» | «error») — это статус
 * ОБРАБОТКИ ЗАПРОСА, а не оплаты: в примере документации `status: "success"`
 * соседствует с `paymentStatus: 0` («в обработке»). Трактовать `status` как
 * оплату = отдавать товар за неоплаченный заказ.
 */
export const ATOL_PAYMENT_STATUS = {
  processing: 0,
  success: 1,
  notResponding: 2,
  error: 3,
  canceled: 4,
  refunded: 5,
  fraud: 6,
  partialCancel: 7,
  partialRefund: 8,
  paymentIsOverdue: 9,
  confirm3ds: 10,
  awaitingDeposit: 11,
  retryError: 12,
} as const;

export type AtolPaymentStatus = (typeof ATOL_PAYMENT_STATUS)[keyof typeof ATOL_PAYMENT_STATUS];

/** Тип события в callback. Один URL на все события, различаются по `type`. */
export type AtolCallbackType = 'payment' | 'deposit' | 'cancel' | 'refund' | 'fiscal';

/** Тип чека в событии фискализации. */
export type AtolReceiptType = 'sell' | 'sell_refund';

/**
 * Позиция чека.
 *
 * 🔴 Сумма позиций ОБЯЗАНА сходиться с `amount` платежа до копейки, иначе АТОЛ
 * отвечает `INVALID_RECEIPT_AMOUNT`. Поэтому доставка и скидка идут
 * ОТДЕЛЬНЫМИ позициями — «сокращённого режима», как у Озона, здесь нет.
 */
export interface AtolPosition {
  name: string;
  /** Цена за единицу в КОПЕЙКАХ. */
  price: number;
  /** Количество в ТЫСЯЧНЫХ: 1 шт = 1000. */
  quantity: number;
  /** Единица измерения (0 = штуки). */
  measure: number;
  /** Признак способа расчёта (0 = предоплата 100%). */
  paymentMethod: number;
  /** Признак предмета расчёта (0 = товар, 3 = услуга/доставка). */
  paymentSubject: number;
  /** Ставка НДС — id словаря. 🔴 «Без НДС» = 5, а 0 = НДС 20%. */
  tax: number;
}

/** Блок фискализации при регистрации платежа. */
export interface AtolReceipt {
  /** 100 = АТОЛ Онлайн: чеки пробивает АТОЛ, отдельная касса не нужна. */
  providerId: number;
  /** Система налогообложения магазина — id словаря. */
  sno: number;
  positions: AtolPosition[];
  buyer?: { email?: string; phone?: string };
}

/** Способ оплаты с указанием банка-эквайера. */
export interface AtolPaymentMethod {
  paymentType: AtolPaymentType;
  /** id банка: для card 600 = Т-Банк; для sbp 400 = Сбербанк. */
  bankId?: number;
}

/** Дополнительные параметры платежа. */
export interface AtolAdditionalProps {
  /** Куда вернуть покупателя с платёжной формы. */
  returnUrl?: string;
  /**
   * Куда слать callback. Приоритет НАД настройкой в ЛК.
   * Сюда же кладём секрет query-параметром — иного канала аутентификации
   * вебхука API не даёт (подписи у callback нет).
   */
  notificationUrl?: string;
}

/** Запрос регистрации платежа: POST /v1/ecom/payments. */
export interface AtolCreatePaymentRequest {
  /** Сумма в КОПЕЙКАХ. Обязана равняться сумме позиций чека. */
  amount: number;
  /** Идентификатор заказа: цифры, латиница и `: + - _ .`. */
  orderId: string;
  sessionType: AtolSessionType;
  additionalProps?: AtolAdditionalProps;
  receipt?: AtolReceipt;
  paymentMethods?: AtolPaymentMethod[];
}

/** Ответ регистрации платежа. */
export interface AtolCreatePaymentResponse {
  orderId: string;
  amount: number;
  paymentUrl: string;
  /** Присутствует при ошибке. */
  errorCode?: string;
  errorMessage?: string;
  status?: string;
}

/** Ответ GET /v1/ecom/payments/{orderId}/status. */
export interface AtolPaymentStatusResponse {
  orderId?: string;
  /** Числовой статус — единственный достоверный признак оплаты. */
  paymentStatus?: number;
  /** Сумма в копейках — сверяем с суммой заказа перед пометкой «оплачен». */
  amount?: number;
  sessionType?: AtolSessionType;
  paidAt?: string | null;
  canceledAt?: string | null;
  errorCode?: string;
  errorMessage?: string;
  status?: string;
}

/**
 * Тело callback (таблицы 6 и 7 документации, объединены: один URL на все события).
 *
 * 🔴 ПОДПИСИ У CALLBACK НЕТ — ни HMAC, ни секрета, ни контрольной суммы.
 * Это отличие от Т-Банка и Озона. Тело само по себе НЕ доказывает отправителя,
 * поэтому решение о смене статуса заказа принимается только по ответу
 * GET /payments/{orderId}/status, запрошенному нами по токену.
 */
export interface AtolCallback {
  /** Статус ОБРАБОТКИ ЗАПРОСА, НЕ факт оплаты. */
  status: 'success' | 'fail' | 'error' | string;
  orderId: string;
  type: AtolCallbackType;
  /** Числовой статус платежа (в событии `fiscal` отсутствует). */
  paymentStatus?: number;
  sessionType?: AtolSessionType;
  amount?: number;
  paidAt?: string | null;
  canceledAt?: string | null;
  depositedAt?: string | null;
  /** Только для события `fiscal`. */
  receiptId?: string;
  receiptType?: AtolReceiptType;
  errorCode?: string;
  errorMessage?: string;
}

/** Результат инициации оплаты (единый по форме с другими провайдерами). */
export interface InitPaymentResult {
  paymentUrl: string;
  paymentId: string;
  status: string | null;
  isMock: boolean;
}

/** Коды ошибок API, на которые реагируем по-разному. */
export const ATOL_ERROR_CODES = {
  /** Неверный токен. Документ врёт про формат заголовка — нужен `Bearer`. */
  authError: 'AUTH_ERROR',
  /** Токен не передан вовсе. */
  noAuthData: 'NO_AUTH_DATA',
  paymentNotFound: 'PAYMENT_NOT_FOUND',
  /** Заказ с таким orderId уже зарегистрирован — основа идемпотентности. */
  paymentExists: 'PAYMENT_EXISTS',
  paymentProcessed: 'PAYMENT_PROCESSED',
  /** Сумма платежа не сошлась с суммой позиций чека. */
  invalidReceiptAmount: 'INVALID_RECEIPT_AMOUNT',
  invalidOrderId: 'INVALID_ORDER_ID',
  permissionDenied: 'PERMISSION_DENIED',
  bankSettingsNotFound: 'BANK_SETTINGS_NOT_FOUND',
} as const;
