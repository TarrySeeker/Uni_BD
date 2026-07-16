/**
 * Фикстуры mock-режима payments/alfabank (порт tbank/mock/fixtures.ts +
 * paykeeper/mock/fixtures.ts).
 *
 * Детерминированные константы для mock-операций: префикс фейкового orderId (mdOrder),
 * базовый внутренний demo-URL (formUrl — страница оплаты), happy-path статусы.
 */

import type { AlfabankOrderStatus } from '../types';

/** Префикс фейкового orderId (mdOrder) в mock-режиме (легко отличим от боевого). */
export const MOCK_ORDER_ID_PREFIX = 'mock-alfa-';

/**
 * Базовый путь внутренней demo-страницы оплаты (formUrl). Витрина/demo редиректит
 * сюда вместо боевой формы Альфа-Банка; кнопки «успех/отказ» дёргают
 * confirmMockPayment. Относительный путь — абсолютизация в роуте/витрине по своему
 * origin (универсально, без хардкода домена).
 */
export const MOCK_PAYMENT_URL_PATH = '/mock/alfabank/pay';

/** Стартовый внутренний статус mock-платежа сразу после register. */
export const MOCK_INIT_STATUS = 'registered';

/** Happy-path orderStatus (полная авторизация — оплачен): cron дотягивает mock до paid. */
export const MOCK_PAID_ORDER_STATUS: AlfabankOrderStatus = 2;

/** orderStatus mock-возврата (по транзакции выполнен возврат). */
export const MOCK_REFUNDED_ORDER_STATUS: AlfabankOrderStatus = 4;

/** orderStatus mock-отказа (авторизация отклонена). */
export const MOCK_DECLINED_ORDER_STATUS: AlfabankOrderStatus = 6;
