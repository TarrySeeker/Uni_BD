/**
 * Фикстуры mock-режима payments/paykeeper (порт tbank/mock/fixtures.ts).
 *
 * Детерминированные константы для mock-операций: префикс фейкового invoice_id,
 * базовый внутренний demo-URL (страница оплаты), happy-path статусы.
 */

import type { PaykeeperStatus } from '../types';

/** Префикс фейкового invoice_id в mock-режиме (легко отличим от боевого). */
export const MOCK_INVOICE_ID_PREFIX = 'mock-inv-';

/**
 * Базовый путь внутренней demo-страницы оплаты (docs/24 §2). Витрина/demo
 * редиректит сюда вместо боевой формы PayKeeper; кнопки «успех/отказ» дёргают
 * confirmMockPayment. Относительный путь — абсолютизация в роуте/витрине по своему
 * origin (универсально, без хардкода домена).
 */
export const MOCK_PAYMENT_URL_PATH = '/mock/paykeeper/pay';

/** Стартовый статус mock-счёта сразу после создания. */
export const MOCK_INIT_STATUS: PaykeeperStatus = 'sent';

/** Happy-path статус подтверждения: покупатель «оплатил». */
export const MOCK_PAID_STATUS: PaykeeperStatus = 'paid';

/** Статус mock-отказа: покупатель «отменил/не оплатил». */
export const MOCK_FAILED_STATUS: PaykeeperStatus = 'failed';
