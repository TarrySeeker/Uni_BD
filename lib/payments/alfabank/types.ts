/**
 * Доменные типы модуля payments/alfabank (порт tbank/types.ts + paykeeper/types.ts
 * на REST-эквайринг Альфа-Банка, платформа RBS).
 *
 * Ключевые отличия от Т-Банка / PayKeeper:
 *   • REST-модель RBS — заказу РЕГИСТРИРУЕТСЯ платёж (register.do), у него orderId
 *     (mdOrder) + formUrl; статус узнаётся числовым orderStatus через
 *     getOrderStatusExtended.do;
 *   • аутентификация запросов — userName/password (params, НЕ подпись Token) —
 *     ближе к простоте PayKeeper Basic-Auth, но через form-параметры;
 *   • колбэк (callbackUrl) — GET с query params mdOrder/orderNumber/operation/status
 *     (+ опц. checksum HMAC symmetric key); суммы register/refund — В КОПЕЙКАХ.
 *
 * Названия полей запроса/ответа Альфа-Банка — camelCase (как в API RBS), доменные
 * результаты модуля — тоже camelCase. Внутренний лог хранит суммы в КОПЕЙКАХ.
 */

import type { PaymentStatus } from '@/lib/orders/types';

// -----------------------------------------------------------------------------
// Числовой статус заказа Альфа-Банка (getOrderStatusExtended.do → orderStatus).
// -----------------------------------------------------------------------------

/**
 * Известные значения orderStatus Альфа-Банка (RBS):
 *   0 — заказ зарегистрирован, но не оплачен;
 *   1 — предавторизованная сумма удержана (двухстадийная, hold);
 *   2 — проведена полная авторизация суммы заказа (оплачен);
 *   3 — авторизация отменена (reversed);
 *   4 — по транзакции выполнен возврат (refunded);
 *   5 — инициирована авторизация через ACS банка-эмитента (3-D Secure);
 *   6 — авторизация отклонена (declined).
 * Тип нестрогий (any number) — перечисление документирует ожидаемые значения.
 */
export type AlfabankOrderStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | (number & {});

/**
 * operation колбэка Альфа-Банка (callbackUrl): факт операции по заказу.
 * deposited — средства зачислены (оплата); approved — предавторизация (hold);
 * reversed — отмена; refunded — возврат; declinedByTimeout — истёк срок.
 */
export type AlfabankOperation =
  | 'deposited'
  | 'approved'
  | 'reversed'
  | 'refunded'
  | 'declinedByTimeout'
  | (string & {});

/** Плоский набор строковых параметров запроса к RBS (form-urlencoded). */
export type AlfabankParams = Record<string, string>;

// -----------------------------------------------------------------------------
// Контракты REST-API RBS (register / getOrderStatusExtended / refund).
// -----------------------------------------------------------------------------

/** Вход регистрации заказа (POST /payment/rest/register.do). Amount — КОПЕЙКИ. */
export interface RegisterOrderInput {
  /** Наш номер заказа (orders.number) → params.orderNumber. */
  orderNumber: string;
  /** Сумма к оплате В КОПЕЙКАХ. */
  amountKop: number;
  /** URL возврата покупателя после успешной оплаты (returnUrl). */
  returnUrl: string;
  /** URL возврата покупателя после неуспешной оплаты (failUrl, опц.). */
  failUrl?: string;
  /** Описание заказа (description, опц.). */
  description?: string;
}

/** Результат регистрации заказа. */
export interface RegisterOrderResult {
  /** orderId Альфа-Банка (mdOrder) = orders.payment_ref. */
  orderId: string;
  /** URL платёжной формы, куда редиректим покупателя. */
  formUrl: string;
}

/** Результат опроса статуса заказа (GET getOrderStatusExtended.do). */
export interface OrderStatusResult {
  /** Числовой orderStatus RBS (или null, если банк не вернул). */
  orderStatus: AlfabankOrderStatus | null;
}

/** Результат возврата (POST refund.do). */
export interface RefundResult {
  /** errorCode RBS: '0' — успех, иначе — код ошибки. */
  errorCode: string;
}

// -----------------------------------------------------------------------------
// Колбэк (callbackUrl) — сырые query-параметры и нормализованное событие.
// -----------------------------------------------------------------------------

/**
 * Сырые query-параметры колбэка Альфа-Банка (callbackUrl, GET). ВАЖНО: checksum
 * (если задан) считается по параметрам БЕЗ самого checksum, отсортированным по имени
 * (см. token.ts). Значения НЕ переформатируются.
 */
export interface AlfabankCallbackParams {
  /** orderId Альфа-Банка (mdOrder) = orders.payment_ref. */
  mdOrder: string;
  /** Наш номер заказа (orders.number; фолбэк поиска заказа). */
  orderNumber: string;
  /** Операция по заказу (deposited/refunded/reversed/…). */
  operation: string;
  /** Итог операции: '1' — успех, '0' — неуспех. */
  status: string;
  /** HMAC-подпись (опц.; верифицируется, только если задан ALFABANK_CALLBACK_SECRET). */
  checksum: string;
  /** Прочие переданные банком query-поля (для HMAC-проверки и аудита). */
  rest: Record<string, string>;
}

/** Нормализованное событие колбэка (порт PaykeeperEvent). */
export interface AlfabankEvent {
  /** orderId Альфа-Банка (mdOrder). */
  orderRef: string | null;
  /** Наш номер заказа (callback.orderNumber). */
  orderNumber: string | null;
  /** Операция (deposited/refunded/…). */
  operation: string | null;
  /** Итог операции ('1'/'0'). */
  status: string | null;
  raw: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Доменные результаты сервиса.
// -----------------------------------------------------------------------------

/** Результат инициации платежа (service.initPayment). */
export interface InitPaymentResult {
  /** orderId Альфа-Банка (mdOrder) = orders.payment_ref. */
  paymentId: string;
  /** URL платёжной формы (formUrl), куда редиректим покупателя. */
  paymentUrl: string;
  /** Внутренний нормализованный статус после регистрации (обычно 'registered'). */
  status: string;
  isMock: boolean;
}

/** Результат обработки колбэка (service.handleCallback). */
export interface HandleCallbackResult {
  /** checksum прошёл проверку (или проверка не требовалась — секрет не задан). */
  verified: boolean;
  /** Заказ найден и переход применён. */
  processed: boolean;
  /** Повторная доставка того же события (идемпотентность). */
  duplicate: boolean;
  /** Целевой payment_status (если был маппинг). */
  paymentStatus: PaymentStatus | null;
}

// Реэкспорт для удобства потребителей status-map.
export type { PaymentStatus };
