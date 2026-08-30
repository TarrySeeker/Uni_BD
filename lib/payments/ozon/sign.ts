/**
 * Подписи Ozon Acquiring (спека docs-ozon/01-подпись-и-токен.md).
 *
 * КЛЮЧЕВОЕ: подпись — ОБЫЧНЫЙ sha256(hex), НЕ HMAC. Порядок полей СВОЙ для
 * каждого метода; secretKey всегда ПОСЛЕДНИЙ. Разделителей нет.
 *
 * ⚠️ Подпись ВЕБХУКА устроена ИНАЧЕ: значения через "|" и другой ключ
 * (notificationSecretKey). Не перепутать — см. notificationSign().
 *
 * Обе схемы проверены на контрольных примерах документации (см. sign.test).
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** sha256 → hex. */
function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Подпись ЗАПРОСА: конкатенация значений БЕЗ разделителей + secretKey в конце.
 * Пустые/отсутствующие поля участвуют как пустая строка (так в спеке для
 * expiresAt и fiscalizationType).
 */
export function requestSign(parts: (string | number | null | undefined)[], secretKey: string): string {
  const body = parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("");
  return sha256hex(body + secretKey);
}

/** Порядок полей подписи createOrder (по таблице спеки). */
export function signCreateOrder(input: {
  accessKey: string;
  expiresAt?: string | null;
  extId?: string | null;
  fiscalizationType?: string | null;
  paymentAlgorithm: string;
  currencyCode: string;
  value: string;
  secretKey: string;
}): string {
  return requestSign(
    [
      input.accessKey,
      input.expiresAt,
      input.extId,
      input.fiscalizationType,
      input.paymentAlgorithm,
      input.currencyCode,
      input.value,
    ],
    input.secretKey,
  );
}

/** getOrderStatus / getOrderDetails: id extId accessKey secretKey. */
export function signOrderLookup(input: {
  id?: string | null;
  extId?: string | null;
  accessKey: string;
  secretKey: string;
}): string {
  return requestSign([input.id, input.extId, input.accessKey], input.secretKey);
}

/** cancelOrder: id accessKey secretKey. */
export function signCancelOrder(input: {
  id: string;
  accessKey: string;
  secretKey: string;
}): string {
  return requestSign([input.id, input.accessKey], input.secretKey);
}

/** refundOrder: id extId accessKey amount.currencyCode amount.value secretKey. */
export function signRefundOrder(input: {
  id: string;
  extId?: string | null;
  accessKey: string;
  currencyCode: string;
  value: string;
  secretKey: string;
}): string {
  return requestSign(
    [input.id, input.extId, input.accessKey, input.currencyCode, input.value],
    input.secretKey,
  );
}

/**
 * Подпись УВЕДОМЛЕНИЯ (вебхука): значения через "|", ключ notificationSecretKey.
 *
 *  - о попытке оплаты ЗАКАЗА:
 *      sha256("{accessKey}|{orderID}|{transactionID}|{extOrderID}|{amount}|{currencyCode}|{notifSecret}")
 *  - о САМОСТОЯТЕЛЬНОЙ оплате:
 *      sha256("{accessKey}|||{extTransactionID}|{amount}|{currencyCode}|{notifSecret}")
 */
export function notificationSign(input: {
  accessKey: string;
  orderID?: string | null;
  transactionID?: string | number | null;
  extOrderID?: string | null;
  amount: string | number;
  currencyCode: string;
  notificationSecretKey: string;
}): string {
  const v = (x: string | number | null | undefined) => (x === null || x === undefined ? "" : String(x));
  const digest = [
    input.accessKey,
    v(input.orderID),
    v(input.transactionID),
    v(input.extOrderID),
    v(input.amount),
    input.currencyCode,
    input.notificationSecretKey,
  ].join("|");
  return sha256hex(digest);
}

/**
 * Сравнение подписей за постоянное время (анти-timing-attack).
 * Регистр hex-строки от Ozon не гарантирован — нормализуем перед сравнением.
 */
export function safeEqualHex(a: string | undefined | null, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a.trim().toLowerCase(), "utf8");
  const y = Buffer.from(b.trim().toLowerCase(), "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
