/**
 * Фикстуры mock-режима payments/tbank (docs/15 §2 mock/fixtures.ts, порт
 * lib/cdek/mock/fixtures.ts).
 *
 * Детерминированные константы для mock-операций: префиксы фейкового PaymentId,
 * базовый внутренний PaymentURL (demo-страница оплаты), happy-path статусы.
 */

import type { TbankStatus } from '../types';

/** Префикс фейкового PaymentId в mock-режиме (легко отличим от боевого). */
export const MOCK_PAYMENT_ID_PREFIX = 'mock-pay-';

/**
 * Базовый путь внутренней demo-страницы оплаты (docs/15 §2.1, §8 волна 1).
 * Витрина/demo редиректит сюда вместо боевой формы Т-Банка; кнопки «успех/отказ»
 * дёргают наш же webhook с валидным mock-Token. Относительный путь — абсолютизация
 * в роуте/витрине по своему origin (универсально, без хардкода домена).
 */
export const MOCK_PAYMENT_URL_PATH = '/mock/tbank/pay';

/** Стартовый статус mock-платежа сразу после Init. */
export const MOCK_INIT_STATUS: TbankStatus = 'NEW';

/**
 * Happy-path статус подтверждения (одностадийная оплата): покупатель «оплатил».
 * Используется mock-webhook-сценарием «успех».
 */
export const MOCK_CONFIRMED_STATUS: TbankStatus = 'CONFIRMED';

/** Статус mock-отказа: покупатель «отменил/не оплатил». */
export const MOCK_REJECTED_STATUS: TbankStatus = 'REJECTED';
