/**
 * Валидация промокода — ЧИСТАЯ функция (docs/07 §3.4).
 *
 * `validatePromo(promo, ctx)` вызывается ДВАЖДЫ: в POST /cart/quote (показать
 * скидку) и ПОВТОРНО внутри транзакции POST /orders (anti-tamper, ADR-010 —
 * витрине нельзя доверять предрасчитанную скидку). Чтобы оставаться чистой и
 * тестируемой без БД, функция принимает счётчики использований (usedCount,
 * customerRedemptions) КАК АРГУМЕНТЫ — чтение из БД лежит в repository.ts.
 *
 * Деньги — копейки внутри (lib/orders/money.ts); вход itemsTotal — строка/число.
 */

import { toMinor } from './money';
import type { AppliedPromo } from './pricing';
import type { PromoCode } from './types';

/** Причина отказа в применении промокода (машиночитаемая). */
export type PromoRejectReason =
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'below_min_total'
  | 'usage_limit_reached'
  | 'per_customer_limit_reached'
  | 'invalid_kind';

/** Контекст валидации промокода (всё, что зависит от заказа/БД — снаружи). */
export interface PromoValidationContext {
  /** Сумма товаров (для min_order_total) — строка NUMERIC или число. */
  itemsTotal: string | number;
  /** Текущий момент (для starts_at/ends_at); по умолчанию now. */
  now?: Date;
  /** Всего использований промокода (promo_codes.used_count) — для usage_limit. */
  usedCount?: number;
  /** Использований этим покупателем (по email) — для per_customer_limit. */
  customerRedemptions?: number;
  /** Суммарное количество единиц в корзине — для min_qty (§5.2, Пакет 5.P-1). */
  itemsQty?: number;
}

/** Результат валидации промокода. */
export type PromoValidationResult =
  | { valid: true; promo: AppliedPromo }
  | { valid: false; reason: PromoRejectReason; message: string };

const REASON_MESSAGE: Record<PromoRejectReason, string> = {
  inactive: 'Промокод неактивен.',
  not_started: 'Промокод ещё не действует.',
  expired: 'Срок действия промокода истёк.',
  below_min_total: 'Сумма заказа меньше минимальной для этого промокода.',
  usage_limit_reached: 'Достигнут лимит использований промокода.',
  per_customer_limit_reached: 'Вы уже использовали этот промокод максимальное число раз.',
  invalid_kind: 'Промокод не может быть применён.',
};

function reject(reason: PromoRejectReason): PromoValidationResult {
  return { valid: false, reason, message: REASON_MESSAGE[reason] };
}

/**
 * Проверяет применимость промокода к заказу (активность, срок, мин.сумма,
 * лимиты). НЕ считает скидку (это делает pricing.calculateQuote по AppliedPromo).
 * Лимиты используют переданные счётчики — функция остаётся чистой.
 */
export function validatePromo(
  promo: PromoCode,
  ctx: PromoValidationContext,
): PromoValidationResult {
  const now = ctx.now ?? new Date();

  // 1) Активность и срок.
  if (!promo.isActive) {
    return reject('inactive');
  }
  if (promo.startsAt && now < promo.startsAt) {
    return reject('not_started');
  }
  if (promo.endsAt && now > promo.endsAt) {
    return reject('expired');
  }

  // 2) Минимальная сумма (сравнение в копейках).
  const itemsMinor = toMinor(ctx.itemsTotal);
  if (itemsMinor < toMinor(promo.minOrderTotal)) {
    return reject('below_min_total');
  }

  // 2a) Минимальное количество единиц (min_qty, §5.2 Пакет 5.P-1).
  if (promo.minQty != null && (ctx.itemsQty ?? 0) < promo.minQty) {
    return reject('below_min_total');
  }

  // 3) Лимит «всего» (usedCount < usageLimit; null = безлимит).
  if (promo.usageLimit != null) {
    const used = ctx.usedCount ?? promo.usedCount ?? 0;
    if (used >= promo.usageLimit) {
      return reject('usage_limit_reached');
    }
  }

  // 4) Лимит на покупателя (по email).
  if (promo.perCustomerLimit != null) {
    const byCustomer = ctx.customerRedemptions ?? 0;
    if (byCustomer >= promo.perCustomerLimit) {
      return reject('per_customer_limit_reached');
    }
  }

  // 5) Тип скидки → AppliedPromo для pricing.
  if (
    promo.kind !== 'percent' &&
    promo.kind !== 'fixed' &&
    promo.kind !== 'free_delivery' &&
    promo.kind !== 'bogo'
  ) {
    return reject('invalid_kind');
  }
  // bogo без корректной пара bogoBuyQty/bogoPayQty неприменим (§5.2 Пакет 5.P-1).
  if (promo.kind === 'bogo' && (promo.bogoBuyQty == null || promo.bogoPayQty == null)) {
    return reject('invalid_kind');
  }

  return {
    valid: true,
    promo: {
      code: promo.code,
      kind: promo.kind,
      value: promo.value,
      maxDiscount: promo.maxDiscount,
      bogoBuyQty: promo.bogoBuyQty,
      bogoPayQty: promo.bogoPayQty,
      applyScope: promo.applyScope,
      minQty: promo.minQty,
    },
  };
}
