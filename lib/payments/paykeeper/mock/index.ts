/**
 * Mock-реализации операций PayKeeper (docs/24 §2, порт tbank/mock/index.ts).
 *
 * Детерминированные функции, помеченные `isMock: true`. Сети здесь НЕТ — это то,
 * что demo-магазин и тесты используют БЕЗ боевого эквайера:
 *   • createInvoice   → фейковый invoice_id + внутренний demo-URL (demo-страница);
 *   • getInvoiceStatus → happy-path статус (по умолчанию paid — cron «дотянет»
 *     зависший mock-платёж до paid).
 *
 * Менеджер выбирает эти функции при manager.isMock (см. manager.ts) — client в
 * mock-режиме НЕ инстанцируется. Mock-URL ведёт на внутреннюю demo-страницу
 * (MOCK_PAYMENT_URL_PATH); orderId/invoiceId/amount — в query, чтобы demo-UI мог
 * подтвердить оплату (confirmMockPayment).
 */

import type { CreateInvoiceResult, InvoiceStatusResult, PaykeeperStatus } from '../types';
import {
  MOCK_INIT_STATUS,
  MOCK_INVOICE_ID_PREFIX,
  MOCK_PAID_STATUS,
  MOCK_PAYMENT_URL_PATH,
} from './fixtures';

export {
  MOCK_INVOICE_ID_PREFIX,
  MOCK_PAYMENT_URL_PATH,
  MOCK_INIT_STATUS,
  MOCK_PAID_STATUS,
  MOCK_FAILED_STATUS,
} from './fixtures';

/** Параметры mock-создания счёта. */
export interface MockCreateInvoiceInput {
  /** Наш номер заказа. */
  orderId: string;
  /** Сумма В РУБЛЯХ (десятичная строка) — для demo-URL/аудита. */
  payAmount: string;
  /**
   * Базовый origin для абсолютного paymentUrl (напр. https://shop.example).
   * Пусто → относительный путь (универсально, без хардкода домена).
   */
  baseOrigin?: string;
  /** Куда demo-страница вернёт покупателя после имитации оплаты (опц.). */
  returnUrl?: string;
}

/** Результат mock-создания счёта (фейковые invoice_id/URL, is_mock). */
export interface MockCreateInvoiceResult extends CreateInvoiceResult {
  status: PaykeeperStatus;
  isMock: true;
}

/** Генерирует детерминированно-форматный, но уникальный фейковый invoice_id. */
function mockInvoiceId(): string {
  const tail = Math.floor(100_000_000 + Math.random() * 900_000_000);
  return `${MOCK_INVOICE_ID_PREFIX}${tail}`;
}

/**
 * Mock-createInvoice (аналог POST /change/invoice/preview/). Возвращает фейковый
 * invoice_id + внутренний demo-URL. URL несёт orderId/invoiceId/amount в query,
 * чтобы demo-UI сымитировал оплату. Без сети, без боевых ключей.
 */
export function mockCreateInvoice(input: MockCreateInvoiceInput): MockCreateInvoiceResult {
  const invoiceId = mockInvoiceId();
  const params = new URLSearchParams({
    orderId: input.orderId,
    invoiceId,
    amount: input.payAmount,
  });
  if (input.returnUrl) params.set('returnUrl', input.returnUrl);
  const path = `${MOCK_PAYMENT_URL_PATH}?${params.toString()}`;
  const invoiceUrl =
    input.baseOrigin && input.baseOrigin.length > 0
      ? `${input.baseOrigin.replace(/\/$/, '')}${path}`
      : path;
  return { invoiceId, invoiceUrl, status: MOCK_INIT_STATUS, isMock: true };
}

/**
 * Mock-getInvoiceStatus (аналог GET /info/invoice/byid/). Детерминированный
 * happy-path: платёж считается оплаченным (paid), чтобы cron/fallback-сверка
 * «дотянула» зависший mock-платёж до paid. Сценарии отказа эмулируются через
 * колбэк/demo, а не через статус.
 */
export function mockGetInvoiceStatus(_invoiceId: string): InvoiceStatusResult & { isMock: true } {
  return { status: MOCK_PAID_STATUS, isMock: true };
}
