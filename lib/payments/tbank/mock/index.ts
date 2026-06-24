/**
 * Mock-реализации операций Т-Банка (docs/15 §2.1, §8 волна 1, порт
 * lib/cdek/mock/index.ts).
 *
 * Детерминированные функции, помеченные `isMock: true`. Сети здесь НЕТ — это то,
 * что demo-магазин и тесты используют БЕЗ боевого терминала:
 *   • initPayment → фейковый PaymentId + внутренний PaymentURL (demo-страница);
 *   • getState    → текущий статус по «правилам» mock;
 *   • cancel      → имитация отмены/возврата.
 *
 * Менеджер выбирает эти функции при manager.isMock (см. manager.ts) — client в
 * mock-режиме НЕ инстанцируется. Mock-PaymentURL ведёт на внутреннюю demo-страницу
 * (MOCK_PAYMENT_URL_PATH); параметры orderId/paymentId — в query, чтобы demo-UI
 * мог дёрнуть webhook с валидным mock-Token.
 */

import { randomUUID } from 'node:crypto';
import type { TbankStatus } from '../types';
import {
  MOCK_CONFIRMED_STATUS,
  MOCK_INIT_STATUS,
  MOCK_PAYMENT_ID_PREFIX,
  MOCK_PAYMENT_URL_PATH,
} from './fixtures';

export {
  MOCK_PAYMENT_ID_PREFIX,
  MOCK_PAYMENT_URL_PATH,
  MOCK_INIT_STATUS,
  MOCK_CONFIRMED_STATUS,
  MOCK_REJECTED_STATUS,
} from './fixtures';

/** Параметры mock-инициации платежа. */
export interface MockInitInput {
  /** Наш номер заказа (Init.OrderId). */
  orderId: string;
  /** Сумма в КОПЕЙКАХ (для сборки demo-URL/аудита). */
  amountKop: number;
  /**
   * Базовый origin для абсолютного PaymentURL (напр. https://shop.example).
   * Пусто → возвращается относительный путь (универсально, без хардкода домена).
   */
  baseOrigin?: string;
  /** Куда demo-страница вернёт покупателя после имитации оплаты (опц.). */
  returnUrl?: string;
}

/** Результат mock-инициации (фейковые PaymentId/PaymentURL, is_mock). */
export interface MockInitResult {
  paymentId: string;
  paymentUrl: string;
  status: TbankStatus;
  isMock: true;
}

/** Генерирует детерминированно-форматный, но уникальный фейковый PaymentId. */
function mockPaymentId(): string {
  // 9 цифр — формат стабилен/тестируем, значение уникально (как mockCreateShipment СДЭК).
  const tail = Math.floor(100_000_000 + Math.random() * 900_000_000);
  return `${MOCK_PAYMENT_ID_PREFIX}${tail}`;
}

/**
 * Mock-Init (аналог POST /v2/Init). Возвращает фейковый PaymentId + внутренний
 * PaymentURL demo-страницы. URL несёт orderId/paymentId/amount в query, чтобы
 * demo-UI мог сымитировать оплату (дёрнуть webhook). Без сети, без боевых ключей.
 */
export function mockInitPayment(input: MockInitInput): MockInitResult {
  const paymentId = mockPaymentId();
  const params = new URLSearchParams({
    orderId: input.orderId,
    paymentId,
    amount: String(input.amountKop),
  });
  if (input.returnUrl) params.set('returnUrl', input.returnUrl);
  const path = `${MOCK_PAYMENT_URL_PATH}?${params.toString()}`;
  const paymentUrl =
    input.baseOrigin && input.baseOrigin.length > 0
      ? `${input.baseOrigin.replace(/\/$/, '')}${path}`
      : path;
  return { paymentId, paymentUrl, status: MOCK_INIT_STATUS, isMock: true };
}

/**
 * Mock-GetState (аналог POST /v2/GetState). Детерминированный happy-path:
 * по умолчанию платёж считается подтверждённым (CONFIRMED), что позволяет
 * cron/fallback-синхронизации «дотянуть» зависший mock-платёж до paid. Конкретные
 * сценарии отказа эмулируются через webhook, а не GetState.
 */
export function mockGetState(_paymentId: string): { status: TbankStatus; isMock: true } {
  return { status: MOCK_CONFIRMED_STATUS, isMock: true };
}

/**
 * Mock-Cancel (аналог POST /v2/Cancel). Имитирует отмену/возврат: до списания —
 * REVERSED, после — REFUNDED. Без флага считаем возвратом (REFUNDED).
 */
export function mockCancel(opts: { authorizedOnly?: boolean } = {}): {
  status: TbankStatus;
  isMock: true;
} {
  return { status: opts.authorizedOnly ? 'REVERSED' : 'REFUNDED', isMock: true };
}

/** Уникальный mock-id события (для аудита/логов, если понадобится). */
export function mockEventId(): string {
  return `mock-evt-${randomUUID()}`;
}
