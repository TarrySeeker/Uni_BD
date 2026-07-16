/**
 * Реестр платёжных провайдеров Admik (docs/24 §2, §7). Тонкий слой выбора
 * активного эквайера по конфигу магазина — регистрирует `paykeeper` наравне с
 * `tbank`/`manual`.
 *
 * Один активный online-эквайер на магазин (docs/24 §2): витрина инициирует оплату
 * через активного провайдера (env PAYMENTS_PROVIDER). Колбэк каждого провайдера
 * приходит на СВОЙ роут (/api/payments/tbank/webhook, /api/payments/paykeeper/callback),
 * поэтому приём событий не зависит от активного провайдера — только инициация.
 *
 * ВАЖНО (границы под-шага 3b): здесь ТОЛЬКО реестр + выбор активного init-провайдера.
 * Мультипровайдерный refund-диспетчер (`lib/orders/actions.ts`) — отдельный под-шаг
 * 3c и здесь НЕ трогается.
 */

import { getEnv } from '@/lib/config/env';

/** Множество известных платёжных провайдеров (== orders_payment_provider_chk). */
export const PAYMENT_PROVIDERS = ['tbank', 'paykeeper', 'alfabank', 'manual'] as const;

/** Платёжный провайдер заказа (orders.payment_provider). */
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** Провайдеры с онлайн-инициацией оплаты (у `manual` витрина оплату не инициирует). */
export const ONLINE_PAYMENT_PROVIDERS = ['tbank', 'paykeeper', 'alfabank'] as const;
export type OnlinePaymentProvider = (typeof ONLINE_PAYMENT_PROVIDERS)[number];

/** true, если провайдер — известный платёжный провайдер Admik. */
export function isPaymentProvider(v: unknown): v is PaymentProvider {
  return typeof v === 'string' && (PAYMENT_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Активный платёжный провайдер витрины (выбор эквайера по конфигу магазина,
 * docs/24 §2). Читается из env PAYMENTS_PROVIDER (дефолт 'tbank'). Принимает
 * опциональный source для тестируемости без мутации process.env.
 */
export function getActivePaymentProvider(
  source?: Record<string, string | undefined>,
): PaymentProvider {
  return getEnv(source ?? process.env).PAYMENTS_PROVIDER;
}
