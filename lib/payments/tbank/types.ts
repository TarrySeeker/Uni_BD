/**
 * Доменные типы модуля payments/tbank (docs/15 §2 «types.ts», §4–5).
 *
 * Контракты T-API (Init/GetState/Cancel) + нормализованное событие webhook
 * (Notification). Все суммы — целые КОПЕЙКИ (docs/15 §1.2). Названия полей
 * запроса/ответа Т-Банка — PascalCase (как в API), доменные результаты модуля —
 * camelCase.
 */

import type { PaymentStatus } from '@/lib/orders/types';

// -----------------------------------------------------------------------------
// Статусы платежа Т-Банка (docs/15 §1.2; полный перечень — сверить по докам/ЛК).
// -----------------------------------------------------------------------------

/**
 * Известные значения Status платежа Т-Банка. Тип нестрогий (допускает любую
 * строку), но перечисление документирует ожидаемые значения для status-map.
 */
export type TbankStatus =
  | 'NEW'
  | 'FORM_SHOWED'
  | 'AUTHORIZING'
  | 'AUTHORIZED'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'REVERSING'
  | 'REVERSED'
  | 'REFUNDING'
  | 'PARTIAL_REFUNDED'
  | 'REFUNDED'
  | 'REJECTED'
  | 'DEADLINE_EXPIRED'
  | 'CANCELED'
  | (string & {});

/** Стадийность оплаты: O — одностадийная (списание сразу), T — двухстадийная (hold→Confirm). */
export type TbankPayType = 'O' | 'T';

// -----------------------------------------------------------------------------
// Подпись Token — допустимые скалярные значения корневых полей.
// -----------------------------------------------------------------------------

/**
 * Скалярное значение корневого поля запроса/уведомления, участвующее в подписи
 * Token. Вложенные объекты/массивы (Receipt/DATA/Items) в подпись НЕ идут
 * (docs/15 §5.1) и в этот тип не входят.
 */
export type TbankScalar = string | number | boolean | null | undefined;

/** Плоский payload корневых полей (значения могут быть и вложенными — отфильтруются при подписи). */
export type TbankPayload = Record<string, unknown>;

// -----------------------------------------------------------------------------
// Контракты T-API (минимальный набор: Init / GetState / Cancel).
// -----------------------------------------------------------------------------

/** Позиция чека 54-ФЗ (docs/15 §6). Суммы — КОПЕЙКИ. */
export interface TbankReceiptItem {
  Name: string;
  Quantity: number;
  Price: number;
  Amount: number;
  Tax: string;
  PaymentMethod?: string;
  PaymentObject?: string;
}

/** Объект чека 54-ФЗ Init.Receipt (docs/15 §6). В подпись Token НЕ идёт. */
export interface TbankReceipt {
  Email?: string;
  Phone?: string;
  Taxation: string;
  Items: TbankReceiptItem[];
}

/**
 * Тело запроса Init (POST /v2/Init). Token добавляется клиентом перед отправкой.
 * Объявлено как `type` (не `interface`): object-literal тип структурно
 * присваиваем к `TbankPayload`/`Record<string, unknown>` (у interface нет
 * неявной index-signature → не присваивается), что нужно для `client.call`.
 */
export type TbankInitRequest = {
  TerminalKey: string;
  Amount: number; // КОПЕЙКИ
  OrderId: string;
  Description?: string;
  PayType?: TbankPayType;
  NotificationURL?: string;
  SuccessURL?: string;
  FailURL?: string;
  RedirectDueDate?: string;
  /** Вложенный объект — в подпись Token НЕ идёт (docs/15 §5.1). */
  Receipt?: TbankReceipt;
  /** Произвольные доп-данные — вложенный объект, в подпись НЕ идёт. */
  DATA?: Record<string, string>;
  Token?: string;
};

/** Ответ Init (docs/15 §4.1). */
export interface TbankInitResponse {
  Success: boolean;
  ErrorCode: string;
  TerminalKey?: string;
  Status?: TbankStatus;
  PaymentId?: string;
  OrderId?: string;
  Amount?: number;
  PaymentURL?: string;
  Message?: string;
  Details?: string;
}

/** Тело запроса GetState (POST /v2/GetState). `type` — присваиваемость к TbankPayload (см. TbankInitRequest). */
export type TbankGetStateRequest = {
  TerminalKey: string;
  PaymentId: string;
  Token?: string;
};

/** Ответ GetState. */
export interface TbankGetStateResponse {
  Success: boolean;
  ErrorCode: string;
  Status?: TbankStatus;
  PaymentId?: string;
  OrderId?: string;
  Amount?: number;
  Message?: string;
  Details?: string;
}

/** Тело запроса Cancel (POST /v2/Cancel) — отмена/возврат. `type` — присваиваемость к TbankPayload (см. TbankInitRequest). */
export type TbankCancelRequest = {
  TerminalKey: string;
  PaymentId: string;
  /** Сумма к отмене/возврату в КОПЕЙКАХ (опц.; пусто = полная). */
  Amount?: number;
  Token?: string;
};

/** Ответ Cancel. */
export interface TbankCancelResponse {
  Success: boolean;
  ErrorCode: string;
  Status?: TbankStatus;
  PaymentId?: string;
  OrderId?: string;
  OriginalAmount?: number;
  NewAmount?: number;
  Message?: string;
  Details?: string;
}

// -----------------------------------------------------------------------------
// Notification (webhook) — сырое тело и нормализованное событие.
// -----------------------------------------------------------------------------

/**
 * Сырое тело уведомления Т-Банка (docs/15 §4.2). Корневые скалярные поля
 * участвуют в проверке Token. Точный набор полей — по докам Т-Банка; читаем
 * толерантно (parseNotification).
 */
export interface TbankNotification {
  TerminalKey?: string;
  OrderId?: string;
  Success?: boolean;
  Status?: TbankStatus;
  PaymentId?: string | number;
  ErrorCode?: string;
  Amount?: number;
  CardId?: string;
  Pan?: string;
  ExpDate?: string;
  Token?: string;
  [key: string]: unknown;
}

/** Нормализованное событие webhook (порт CdekEvent). */
export interface TbankEvent {
  /** Наш номер заказа (Notification.OrderId). */
  orderNumber: string | null;
  /** PaymentId Т-Банка (строка). */
  paymentId: string | null;
  status: TbankStatus | null;
  amountKop: number | null;
  /** Token из тела (для verify). */
  token: string | null;
  raw: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Доменные результаты сервиса.
// -----------------------------------------------------------------------------

/** Результат инициации платежа (service.initPayment). */
export interface InitPaymentResult {
  paymentId: string;
  paymentUrl: string;
  status: TbankStatus;
  isMock: boolean;
}

/** Результат обработки webhook (service.handleWebhook), порт HandleResult СДЭК. */
export interface HandleWebhookResult {
  /** Token прошёл проверку. */
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
