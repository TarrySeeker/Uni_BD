/**
 * Доменные типы модуля payments/paykeeper (docs/24 §2, порт tbank/types.ts на
 * ИНВОЙСНУЮ модель PayKeeper).
 *
 * Ключевые отличия от Т-Банка (docs/24 §2):
 *   • инвойсная модель — заказу выставляется счёт (invoice), у него invoice_id/
 *     invoice_url; статус узнаётся через GET /info/invoice/byid/;
 *   • колбэк — application/x-www-form-urlencoded с MD5-подписью key =
 *     md5(id+sum+clientid+orderid+secret); ответ строго `OK `+md5(id+secret);
 *   • суммы — В РУБЛЯХ (десятичная строка), не в копейках.
 *
 * Названия полей запроса/колбэка PayKeeper — snake_case (как в API), доменные
 * результаты модуля — camelCase. Внутренний лог хранит суммы в КОПЕЙКАХ (единый
 * формат Admik) — конвертация на границе адаптера.
 */

import type { PaymentStatus } from '@/lib/orders/types';

// -----------------------------------------------------------------------------
// Статусы платежа PayKeeper (docs/24 §2; из /info/invoice/byid/ и колбэка).
// -----------------------------------------------------------------------------

/**
 * Известные значения статуса счёта/платежа PayKeeper. Тип нестрогий (любая
 * строка), перечисление документирует ожидаемые значения для status-map.
 * Синтетический 'PAID' — присваивается адаптером на успешном колбэке (колбэк сам
 * статус не несёт, только факт успешной оплаты).
 */
export type PaykeeperStatus =
  | 'new'
  | 'waiting'
  | 'pending'
  | 'sent'
  | 'paid'
  | 'PAID'
  | 'expired'
  | 'cancelled'
  | 'canceled'
  | 'fail'
  | 'failed'
  | 'error'
  | 'refunded'
  | 'reversed'
  | 'returned'
  | (string & {});

// -----------------------------------------------------------------------------
// Позиция чека для service_name (JSON внутри тела инвойса).
// -----------------------------------------------------------------------------

/** Позиция корзины для service_name счёта PayKeeper (docs/24 §2). Суммы — рубли. */
export interface PaykeeperCartItem {
  name: string;
  /** Цена за единицу (рубли, десятичная строка/число). */
  price: string | number;
  quantity: number;
  /** Сумма по строке (рубли). */
  sum: string | number;
  /** Ставка НДС позиции (vat20|vat10|…). */
  tax: string;
}

// -----------------------------------------------------------------------------
// Контракты серверного API (создание счёта / статус).
// -----------------------------------------------------------------------------

/** Тело создания счёта (POST /change/invoice/preview/, form-urlencoded). */
export interface CreateInvoiceInput {
  /** Сумма к оплате В РУБЛЯХ (десятичная строка). */
  payAmount: string;
  /** Идентификатор клиента (имя/email/телефон покупателя). */
  clientId: string;
  /** Наш номер заказа (orders.number). */
  orderId: string;
  /** Позиции корзины для service_name. */
  cart: PaykeeperCartItem[];
  /** Телефон покупателя (для чека). */
  clientPhone?: string;
  /** Email покупателя (для чека). */
  clientEmail?: string;
}

/** Результат создания счёта. */
export interface CreateInvoiceResult {
  invoiceId: string;
  invoiceUrl: string;
}

/** Результат опроса статуса счёта (GET /info/invoice/byid/). */
export interface InvoiceStatusResult {
  status: PaykeeperStatus | null;
}

// -----------------------------------------------------------------------------
// Колбэк (webhook) — сырые posted-строки и нормализованное событие.
// -----------------------------------------------------------------------------

/**
 * Сырые posted-строки колбэка PayKeeper (application/x-www-form-urlencoded).
 * ВАЖНО (docs/24 §2): подпись считается по ИМЕННО этим строкам (sum не
 * переформатировать — toFixed сломал бы подпись).
 */
export interface PaykeeperCallbackParams {
  /** id счёта PayKeeper (= orders.payment_ref). */
  id: string;
  /** Сумма оплаты (сырая строка — участвует в подписи как есть). */
  sum: string;
  /** Идентификатор клиента (участвует в подписи). */
  clientid: string;
  /** Наш номер заказа (участвует в подписи; фолбэк поиска заказа). */
  orderid: string;
  /** Подпись md5(id+sum+clientid+orderid+secret). */
  key: string;
}

/** Нормализованное событие колбэка (порт TbankEvent). */
export interface PaykeeperEvent {
  /** id счёта PayKeeper. */
  invoiceId: string | null;
  /** Наш номер заказа (callback.orderid). */
  orderNumber: string | null;
  /** Сумма оплаты (сырая строка). */
  sum: string | null;
  /** Подпись из тела (для verify). */
  key: string | null;
  raw: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Доменные результаты сервиса.
// -----------------------------------------------------------------------------

/** Результат инициации платежа (service.initPayment). */
export interface InitPaymentResult {
  invoiceId: string;
  paymentUrl: string;
  status: PaykeeperStatus;
  isMock: boolean;
}

/** Результат обработки колбэка (service.handleCallback). */
export interface HandleCallbackResult {
  /** Подпись прошла проверку. */
  verified: boolean;
  /** Заказ найден и переход применён. */
  processed: boolean;
  /** Повторная доставка того же события (идемпотентность). */
  duplicate: boolean;
  /** Целевой payment_status (если был маппинг). */
  paymentStatus: PaymentStatus | null;
  /**
   * true → сумма колбэка (`sum`) НЕ совпала с серверным `grand_total`: заказ НЕ
   * помечен paid, событие записано в лог для РУЧНОЙ сверки (docs/24 §2, anti-tamper).
   * ack всё равно отдаётся (подпись валидна, ретраи сумму не изменят).
   */
  amountMismatch?: boolean;
  /**
   * Строка подтверждения для PayKeeper (`OK `+md5(id+secret)) — заполняется ТОЛЬКО
   * на верифицированном событии (в т.ч. дубликате). Невалидная подпись → null.
   */
  ack: string | null;
}

// Реэкспорт для удобства потребителей status-map.
export type { PaymentStatus };
