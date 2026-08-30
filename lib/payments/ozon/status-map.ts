/**
 * Маппинг статусов Ozon Acquiring → orders.payment_status Admik.
 * ЧИСТАЯ, без сети/БД (порт lib/payments/tbank/status-map.ts).
 *
 * У Ozon ДВА независимых словаря, их нельзя смешивать:
 *   1) статус ЗАКАЗА (getOrderStatus.status) — STATUS_*;
 *   2) статус транзакции в ВЕБХУКЕ — Completed | Rejected | Authorized.
 *
 * Существующий PaymentStatus (pending|authorized|paid|failed|refunded)
 * покрывает все исходы Ozon — новых значений в БД не требуется.
 */

import type { PaymentStatus } from "@/lib/orders/types";
import type { OzonOrderStatus, OzonWebhookStatus } from "./types";

/**
 * Статус ЗАКАЗА Ozon → payment_status.
 *
 * НАМЕРЕННО не маппятся (→ null, событие логируется, решает оператор):
 *   • STATUS_PARTITIONAL_REFUND / STATUS_PARTITION_CANCELED — ЧАСТИЧНЫЙ возврат:
 *     авто-переход в refunded закрыл бы заказ целиком и высвободил ВЕСЬ резерв
 *     остатков, хотя вернулась лишь часть денег (тот же баг лечили в tbank).
 *   • STATUS_DISPUTED / STATUS_DISPUTING — спор идёт, деньги ещё не решены.
 *   • STATUS_NEW — заказ создан, но к оплате не готов.
 */
export const ORDER_STATUS_TO_PAYMENT: Readonly<Partial<Record<OzonOrderStatus, PaymentStatus>>> = {
  STATUS_PAYMENT_PENDING: "pending",
  // Одностадийный SMS сюда не попадает; для DMS — средства захолдированы.
  STATUS_AUTHORIZED: "authorized",
  STATUS_PAID: "paid",
  STATUS_CANCELED: "failed",
  STATUS_EXPIRED: "failed",
  // Полный возврат — терминальный сетл (освобождение резерва, откат промокода).
  STATUS_REFUNDED: "refunded",
};

/**
 * Статус транзакции из ВЕБХУКА → payment_status.
 *
 * Authorized приходит для двухстадийных оплат (деньги захолдированы, но ещё не
 * списаны) — это НЕ «оплачено». Магазин работает одностадийно (PAY_ALGO_SMS),
 * так что штатный успешный исход — Completed.
 */
export const WEBHOOK_STATUS_TO_PAYMENT: Readonly<Record<OzonWebhookStatus, PaymentStatus>> = {
  Completed: "paid",
  Authorized: "authorized",
  Rejected: "failed",
};

/** Статус заказа Ozon → payment_status, либо null если авто-переход не нужен. */
export function mapOrderStatus(status: string | undefined | null): PaymentStatus | null {
  if (!status) return null;
  return ORDER_STATUS_TO_PAYMENT[status as OzonOrderStatus] ?? null;
}

/** Статус вебхука → payment_status, либо null для неизвестного значения. */
export function mapWebhookStatus(status: string | undefined | null): PaymentStatus | null {
  if (!status) return null;
  return WEBHOOK_STATUS_TO_PAYMENT[status as OzonWebhookStatus] ?? null;
}

/** Расшифровки errorCode вебхука — для журнала и разбора обращений покупателей. */
export const ERROR_CODE_LABELS: Readonly<Record<number, string>> = {
  1: "ошибка не определена",
  2: "ошибка прохождения 3DS",
  3: "срок действия карты истёк",
  4: "недостаточно средств",
  5: "подозрение на мошенническую операцию",
  6: "неверный код подтверждения",
  7: "некорректный запрос",
  8: "превышены ограничения",
  9: "ограниченная операция",
  10: "некорректная карта",
  11: "превышено время ожидания провайдера",
  12: "запрещённая страна",
  13: "ошибка авторизации",
  14: "превышено время ожидания 3DS",
  15: "ресурс не найден",
  16: "некорректные данные авторизации",
  17: "доступ запрещён",
  18: "превышено количество запросов",
  19: "внутренняя ошибка сервера",
  20: "превышено внутреннее время ожидания",
  21: "истёк срок подтверждения",
  22: "превышено время ожидания формы оплаты",
};

/** Человекочитаемое описание кода ошибки попытки оплаты. */
export function describeErrorCode(code: number | undefined | null): string | null {
  if (code === undefined || code === null) return null;
  return ERROR_CODE_LABELS[code] ?? `неизвестный код ${code}`;
}
