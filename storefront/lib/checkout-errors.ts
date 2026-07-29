/**
 * Перевод МАШИННЫХ кодов отказа Storefront API в человеческие строки словаря.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Карты кодов жили внутри CheckoutForm (клиентский
 * React-компонент) и потому не покрывались тестами: аудит 2026-07-26 (находки
 * №3, №6, №15, №16) показал, что домен и витрина говорили на РАЗНЫХ наборах
 * значений — из 8 причин отказа промокода совпадали 3, а все шесть переводов
 * ошибок оформления были недостижимы, потому что сервер присылал только
 * транспортный код. Здесь набор зафиксирован явно и сверяется тестом с серверным
 * алфавитом (lib/storefront/error-reasons.ts).
 *
 * 🔴 ИНВАРИАНТ: покупателю показываются ТОЛЬКО строки словаря витрины. Ни сырой
 * машинный код, ни серверный `message` (он на языке магазина) в интерфейс не
 * попадают ни по одной ветке — функции ниже физически не принимают текст ошибки.
 */

import type { Dictionary } from './dictionaries';

/** Подсекция словаря чекаута — все локализованные подписи формы. */
export type CheckoutDict = Dictionary['checkout'];

// -----------------------------------------------------------------------------
// Публичный алфавит (зеркало lib/storefront/error-reasons.ts на сервере).
// Расхождение ловится тестом tests/storefront-ui/checkout-error-alphabet.test.ts.
// -----------------------------------------------------------------------------

/** Причина недоступности позиции корзины — QuoteDto.issues[].code. */
export const CART_ITEM_ISSUE_REASONS = [
  'product_not_found',
  'variant_not_found',
  'inactive',
  'out_of_stock',
] as const;

/** Причина отказа промокода — QuoteDto.promo.reason. */
export const PROMO_REJECT_REASONS = [
  'not_found',
  'inactive',
  'not_started',
  'expired',
  'below_min_total',
  'below_min_qty',
  'usage_limit_reached',
  'per_customer_limit_reached',
  'invalid_kind',
] as const;

/** Причина отказа подарочного сертификата — QuoteDto.gift.reason. */
export const GIFT_REJECT_REASONS = [
  'not_found',
  'expired',
  'depleted',
  'disabled',
  'no_amount_due',
] as const;

/** Доменная причина отказа оформления/оплаты — error.reason. */
export const ORDER_ERROR_REASONS = [
  'out_of_stock',
  'invalid_item',
  'invalid_promo',
  'invalid_gift',
  'delivery_unavailable',
  'invalid_zone',
  'payments_disabled',
  'order_not_found',
  'order_not_payable',
  'payment_init_failed',
  'payment_in_progress',
  /** Итог, показанный покупателю, разошёлся с фактическим итогом заказа. */
  'total_mismatch',
] as const;

// -----------------------------------------------------------------------------
// Карты «код → строка словаря».
// -----------------------------------------------------------------------------

/**
 * Подпись причины проблемы позиции (issues[].code из /cart/quote).
 * Неизвестный код НЕ показываем покупателю сырым — общий текст словаря.
 */
export function issueLabel(t: CheckoutDict, code: string): string {
  const map: Record<string, string> = {
    // Доменный алфавит сервера.
    product_not_found: t.issueNotFound,
    variant_not_found: t.issueVariantNotFound,
    inactive: t.issueInactive,
    out_of_stock: t.issueOutOfStock,
    // Исторические синонимы витрины — оставлены, чтобы не ломать старые ответы.
    not_found: t.issueNotFound,
    invalid_item: t.issueInvalidItem,
  };
  return map[code] ?? t.issueInvalidItem;
}

/**
 * Подпись причины отказа промокода (promo.reason из /cart/quote).
 * Аудит №15/№16: домен присылает below_min_total/below_min_qty/
 * usage_limit_reached/per_customer_limit_reached/invalid_kind — раньше витрина
 * знала только «свои» имена и роняла пять причин из девяти в общий текст.
 */
export function promoReasonLabel(t: CheckoutDict, reason: string): string {
  const map: Record<string, string> = {
    not_found: t.promoReasonNotFound,
    inactive: t.promoReasonInactive,
    not_started: t.promoReasonNotStarted,
    expired: t.promoReasonExpired,
    below_min_total: t.promoReasonMinOrder,
    below_min_qty: t.promoReasonBelowMinQty,
    usage_limit_reached: t.promoReasonUsageLimit,
    per_customer_limit_reached: t.promoReasonPerCustomerLimit,
    invalid_kind: t.promoReasonInvalidKind,
    // Исторические синонимы витрины (совместимость со старым сервером).
    usage_limit: t.promoReasonUsageLimit,
    min_order: t.promoReasonMinOrder,
    per_customer_limit: t.promoReasonPerCustomerLimit,
  };
  return map[reason] ?? t.promoNotApplied;
}

/**
 * Подпись причины отказа подарочного сертификата (gift.reason из /cart/quote).
 * 🔴 Сырой машинный код покупателю не показывается НИКОГДА: неизвестная причина
 * (или новый код на сервере) падает в общий человекочитаемый текст словаря.
 */
export function giftReasonLabel(t: CheckoutDict, reason: string): string {
  const map: Record<string, string> = {
    not_found: t.giftReasonNotFound,
    expired: t.giftReasonExpired,
    depleted: t.giftReasonDepleted,
    disabled: t.giftReasonDisabled,
    no_amount_due: t.giftReasonNoAmountDue,
  };
  return map[reason] ?? t.giftCodeNotApplied;
}

/** Машиночитаемая часть ошибки запроса (без текста — текст не показываем). */
export interface ErrorCodes {
  /** Транспортный код ответа (или клиентский: network). */
  code?: string | null;
  /** Доменная причина из публичного алфавита, если сервер её прислал. */
  reason?: string | null;
}

/**
 * Подпись ошибки оформления/оплаты.
 *
 * ПРИОРИТЕТ: доменная причина (`reason`) → транспортный код (`code`). Второе —
 * лишь для кодов, у которых есть СВОЙ смысл для покупателя (сеть, лимит
 * запросов); голый 'unprocessable'/'conflict' смысла не несёт.
 *
 * Возвращает `null`, если код неизвестен, — вызывающий логирует диагностику в
 * консоль и показывает общий текст словаря. Так исключается утечка сырого кода
 * и серверного сообщения в интерфейс.
 */
export function orderErrorLabel(t: CheckoutDict, err: ErrorCodes | null): string | null {
  if (!err) return null;
  const byReason: Record<string, string> = {
    out_of_stock: t.orderErrorOutOfStock,
    invalid_item: t.orderErrorInvalidItem,
    invalid_promo: t.orderErrorInvalidPromo,
    invalid_gift: t.orderErrorInvalidGift,
    delivery_unavailable: t.orderErrorDeliveryUnavailable,
    invalid_zone: t.orderErrorInvalidZone,
    payments_disabled: t.orderErrorPaymentsDisabled,
    order_not_found: t.orderErrorOrderNotFound,
    order_not_payable: t.orderErrorOrderNotPayable,
    payment_init_failed: t.orderErrorPaymentInitFailed,
    // 🔴 Холд: деньги удержаны, подтверждение в пути. Отдельный текст — иначе
    // покупатель читает «оплатить нельзя» и идёт платить ещё раз с другой карты.
    payment_in_progress: t.orderErrorPaymentInProgress,
    // 🔴 Сумма изменилась между расчётом и оформлением: покупателю нужно вернуться
    // к корзине и увидеть актуальный итог, а не «попробовать ещё раз» вслепую.
    total_mismatch: t.orderErrorTotalMismatch,
  };
  if (err.reason && byReason[err.reason]) {
    return byReason[err.reason]!;
  }
  // Транспортные/клиентские коды со своим смыслом для покупателя.
  const byCode: Record<string, string> = {
    network: t.orderErrorNetwork,
    rate_limited: t.orderErrorRateLimited,
  };
  if (err.code && byCode[err.code]) {
    return byCode[err.code]!;
  }
  return null;
}
