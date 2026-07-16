/**
 * Mock-реализации операций Альфа-Банка (порт tbank/mock/index.ts + paykeeper/mock).
 *
 * Детерминированные функции, помеченные `isMock: true`. Сети здесь НЕТ — это то, что
 * demo-магазин и тесты используют БЕЗ боевого мерчанта:
 *   • register        → фейковый orderId (mdOrder) + внутренний demo-URL (formUrl);
 *   • getOrderStatus  → happy-path orderStatus (по умолчанию 2=оплачен → cron
 *     «дотягивает» зависший mock-платёж до paid);
 *   • refund          → успех (errorCode '0').
 *
 * Менеджер выбирает эти функции при manager.isMock (см. manager.ts) — client в
 * mock-режиме НЕ инстанцируется. Mock-formUrl ведёт на внутреннюю demo-страницу
 * (MOCK_PAYMENT_URL_PATH); orderId/orderNumber/amount — в query, чтобы demo-UI мог
 * подтвердить оплату (confirmMockPayment).
 */

import type { AlfabankOrderStatus, OrderStatusResult, RefundResult } from '../types';
import {
  MOCK_INIT_STATUS,
  MOCK_ORDER_ID_PREFIX,
  MOCK_PAID_ORDER_STATUS,
  MOCK_PAYMENT_URL_PATH,
} from './fixtures';

export {
  MOCK_ORDER_ID_PREFIX,
  MOCK_PAYMENT_URL_PATH,
  MOCK_INIT_STATUS,
  MOCK_PAID_ORDER_STATUS,
  MOCK_REFUNDED_ORDER_STATUS,
  MOCK_DECLINED_ORDER_STATUS,
} from './fixtures';

/** Параметры mock-регистрации заказа. */
export interface MockRegisterInput {
  /** Наш номер заказа (register.orderNumber). */
  orderNumber: string;
  /** Сумма В КОПЕЙКАХ (для demo-URL/аудита). */
  amountKop: number;
  /**
   * Базовый origin для абсолютного formUrl (напр. https://shop.example). Пусто →
   * относительный путь (универсально, без хардкода домена).
   */
  baseOrigin?: string;
  /** Куда demo-страница вернёт покупателя после имитации оплаты (опц.). */
  returnUrl?: string;
}

/** Результат mock-регистрации (фейковые orderId/formUrl, is_mock). */
export interface MockRegisterResult {
  orderId: string;
  formUrl: string;
  status: string;
  isMock: true;
}

/** Генерирует детерминированно-форматный, но уникальный фейковый orderId (mdOrder). */
function mockOrderId(): string {
  const tail = Math.floor(100_000_000 + Math.random() * 900_000_000);
  return `${MOCK_ORDER_ID_PREFIX}${tail}`;
}

/**
 * Mock-register (аналог POST /payment/rest/register.do). Возвращает фейковый orderId
 * (mdOrder) + внутренний demo-URL (formUrl). URL несёт orderNumber/orderId/amount в
 * query, чтобы demo-UI сымитировал оплату. Без сети, без боевых ключей.
 */
export function mockRegisterOrder(input: MockRegisterInput): MockRegisterResult {
  const orderId = mockOrderId();
  const params = new URLSearchParams({
    orderNumber: input.orderNumber,
    orderId,
    amount: String(input.amountKop),
  });
  if (input.returnUrl) params.set('returnUrl', input.returnUrl);
  const path = `${MOCK_PAYMENT_URL_PATH}?${params.toString()}`;
  const formUrl =
    input.baseOrigin && input.baseOrigin.length > 0
      ? `${input.baseOrigin.replace(/\/$/, '')}${path}`
      : path;
  return { orderId, formUrl, status: MOCK_INIT_STATUS, isMock: true };
}

/**
 * Mock-getOrderStatus (аналог GET getOrderStatusExtended.do). Детерминированный
 * happy-path: заказ считается оплаченным (orderStatus=2), чтобы cron/fallback-сверка
 * «дотянула» зависший mock-платёж до paid. Сценарии отказа эмулируются через
 * колбэк/demo, а не через статус.
 */
export function mockGetOrderStatus(
  _orderId: string,
): OrderStatusResult & { isMock: true } {
  return { orderStatus: MOCK_PAID_ORDER_STATUS, isMock: true };
}

/**
 * Mock-refund (аналог POST refund.do). Имитирует успешный возврат: errorCode '0'.
 */
export function mockRefund(_opts: { authorizedOnly?: boolean } = {}): RefundResult & {
  isMock: true;
} {
  return { errorCode: '0', isMock: true };
}

/** Возвращает orderStatus, соответствующий успешному mock-возврату (для аудита). */
export function mockRefundedOrderStatus(): AlfabankOrderStatus {
  return 4;
}
