/**
 * Типы модуля payments/ozon (Ozon Acquiring API 1.0.0).
 * Спека: docs-ozon/01..03 (выжимка из docs.ozon.ru/api/acquiring).
 *
 * КЛЮЧЕВОЕ ОТЛИЧИЕ от Т-Банка: для оплаты КАРТОЙ используется путь ЗАКАЗОВ
 * (/v1/createOrder → order.payLink). Метод /v1/createPayment поддерживает
 * payType ТОЛЬКО SBP, картой через него платить нельзя.
 */

/** Алгоритм оплаты. SMS — одностадийный (списание сразу), DMS — двухстадийный. */
export type OzonPayAlgorithm = "PAY_ALGO_SMS" | "PAY_ALGO_DMS";

/** Тип фискализации. SINGLE — одинарная, DOUBLE — двойная (нужен createFinalReceipt). */
export type OzonFiscalizationType = "FISCAL_TYPE_SINGLE" | "FISCAL_TYPE_DOUBLE";

/** Режим заказа. FULL — с составом корзины (обязателен при фискализации). */
export type OzonOrderMode = "MODE_FULL" | "MODE_SHORTENED";

/** Статусы ЗАКАЗА (getOrderStatus.status). */
export type OzonOrderStatus =
  | "STATUS_NEW"
  | "STATUS_PAYMENT_PENDING"
  | "STATUS_PAID"
  | "STATUS_PARTITIONAL_REFUND"
  | "STATUS_AUTHORIZED"
  | "STATUS_CANCELED"
  | "STATUS_DISPUTED"
  | "STATUS_EXPIRED"
  | "STATUS_REFUNDED"
  | "STATUS_PARTITION_CANCELED"
  | "STATUS_DISPUTING";

/** Статус транзакции в ВЕБХУКЕ — отдельный словарь, НЕ равен OzonOrderStatus. */
export type OzonWebhookStatus = "Completed" | "Rejected" | "Authorized";

/** Способ оплаты в вебхуке. */
export type OzonPaymentMethod =
  | "PAY_TYPE_BANK_CARD"
  | "PAY_TYPE_SBP"
  | "PAY_TYPE_OZON_CARD";

/** Сумма. value — строка; в API заказов это РУБЛИ, в вебхуке amount — КОПЕЙКИ. */
export interface OzonAmount {
  currencyCode: string;
  value: string;
}

/** Позиция корзины для createOrder (MODE_FULL). */
export interface OzonItem {
  name: string;
  price: OzonAmount;
  quantity: number;
  vat: string;
  type?: "TYPE_PRODUCT";
  extId?: string;
  needMark?: boolean;
}

/** Запрос createOrder. */
export interface OzonCreateOrderRequest {
  accessKey: string;
  amount: OzonAmount;
  paymentAlgorithm: OzonPayAlgorithm;
  requestSign: string;
  extId?: string;
  expiresAt?: string;
  mode?: OzonOrderMode;
  items?: OzonItem[];
  successUrl?: string;
  failUrl?: string;
  notificationUrl?: string;
  receiptEmail?: string;
  fiscalizationPhone?: string;
  enableFiscalization?: boolean;
  fiscalizationType?: OzonFiscalizationType;
}

/** Заказ в ответе Ozon. */
export interface OzonOrder {
  id: string;
  extId?: string;
  number?: string;
  /** ССЫЛКА НА ОПЛАТУ — сюда редиректим покупателя. */
  payLink?: string;
  status: OzonOrderStatus;
  isTestMode?: boolean;
  mode?: OzonOrderMode;
  paymentAlgorithm?: OzonPayAlgorithm;
  remainingAmount?: OzonAmount;
  items?: unknown[];
}

/** Ответ createOrder. */
export interface OzonCreateOrderResponse {
  order?: OzonOrder;
  extData?: Record<string, string>;
}

/** Ответ getOrderStatus. */
export interface OzonOrderStatusResponse {
  id?: string;
  extId?: string;
  status?: OzonOrderStatus;
  isTestMode?: boolean;
  originalAmount?: OzonAmount;
  remainingAmount?: OzonAmount;
}

/**
 * Тело POST-уведомления Ozon.
 * ⚠️ Ozon шлёт идентификатор транзакции то как transactionUid, то как
 * transactionUID — в спеке встречаются оба написания; читаем оба.
 */
export interface OzonNotification {
  orderID?: string;
  extOrderID?: string;
  transactionID?: number | string;
  transactionUid?: string;
  transactionUID?: string;
  /** Сумма в КОПЕЙКАХ: 10050 = 100 руб. 50 коп. */
  amount?: number | string;
  currencyCode?: string;
  paymentTime?: string;
  testMode?: number;
  status?: OzonWebhookStatus | string;
  operationType?: string;
  extData?: unknown;
  paymentMethod?: OzonPaymentMethod | string;
  requestSign?: string;
  extTransactionID?: string;
  items?: { extID?: string }[];
  errorCode?: number;
  errorMessage?: string;
}

/** Результат инициации оплаты (возвращается витрине). */
export interface InitPaymentResult {
  paymentUrl: string;
  /** id заказа на стороне эквайринга (кладём в orders.payment_ref). */
  paymentId: string;
  status: string;
  isMock: boolean;
}

/** Коды ошибок Ozon Acquiring. 16 = неверная подпись (при HTTP 400). */
export const OZON_ERROR_CODES = {
  UNKNOWN: 2,
  BAD_USER_INPUT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  FAILED_PRECONDITION: 9,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
} as const;
