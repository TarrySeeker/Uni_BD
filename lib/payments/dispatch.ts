/**
 * Мультипровайдерный refund-диспетчер (docs/24 §7, ADR-P1-3).
 *
 * ПРОБЛЕМА (SECURITY-CRITICAL, деньги/возвраты): `lib/orders/actions.ts` зовёт
 * `PaymentService.refundPayment` из `@/lib/payments/tbank` для ЛЮБОГО провайдера.
 * Для заказа с `payment_provider='paykeeper'` это неверно — обращение к чужому
 * шлюзу. Диспетчер маршрутизирует возврат по `orders.payment_provider`.
 *
 * РЕШЕНИЕ: тонкий exhaustive switch:
 *   • `tbank`     → tbank `PaymentService.refundPayment` (поведение НЕ меняется);
 *   • `paykeeper` → paykeeper `PaymentService.refundPayment` (MVP `skipped:'manual'`);
 *   • `manual`    → внутренний возврат БЕЗ внешнего вызова (`skipped`): реальный
 *                   возврат делает внутренний сетл `applyOrderStatusTransition`;
 *   • `gift`      → внутренний skip (`gift_orthogonal`): возврат баланса сертификата
 *                   ОРТОГОНАЛЕН платёжному refund и делается `releaseGiftTx` внутри
 *                   `settleRefundEffectsTx`/`applyOrderStatusTransition` (по order_id,
 *                   идемпотентно), а НЕ здесь. Отдельного шлюзового reverse у
 *                   сертификата нет. На практике `payment_provider='gift'` в БД не
 *                   встречается (CHECK `orders_payment_provider_chk`): частичное
 *                   покрытие → провайдер остатка (tbank/paykeeper), полное покрытие →
 *                   `manual` (к оплате 0). Ветка — forward-compat/защита от рассинхрона;
 *   • `NULL`      → офлайн/COD (`payment_provider` не проставлен на COD/наличных):
 *                   онлайн-шлюза для reverse нет, внутренний сетл вернёт деньги
 *                   вручную. КРИТИЧНО: НЕ маршрутизируем в tbank (иначе Cancel в
 *                   Т-Банке по чужому/несуществующему PaymentId);
 *   • иной НЕ-null провайдер → безопасная ОШИБКА (НЕ дефолт-tbank): не угадываем
 *                   чужой шлюз для неизвестного значения (деньги) — возврат заказа
 *                   отклоняется, оператор разбирается вручную.
 *
 * Тонкий слой: НЕ трогает `payment_status` (внутренний сетл — вызывающий), НЕ
 * дублирует anti-tamper (серверные суммы считает вызывающий, ADR-010).
 */

import { PaymentService as TbankPaymentService } from '@/lib/payments/tbank';
import { PaymentService as PaykeeperPaymentService } from '@/lib/payments/paykeeper';
import { PaymentService as AlfabankPaymentService } from '@/lib/payments/alfabank';
import { OrderError } from '@/lib/orders/errors';

/** Вход шлюзового возврата (единый контракт tbank/paykeeper `refundPayment`). */
export interface RefundDispatchInput {
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  paymentProvider: string | null;
  paymentRef: string | null;
  amountKop: number;
}

/** Результат шлюзового возврата (общая форма tbank/paykeeper `RefundPaymentResult`). */
export interface RefundDispatchResult {
  /** Возврат принят шлюзом ИЛИ корректно пропущен. false → шлюз отказал. */
  ok: boolean;
  /** Сырой статус шлюза (или null для skipped/внутреннего). */
  status: string | null;
  isMock: boolean;
  /** true → шлюзовой возврат не выполнялся (внутренний/COD/manual/gift). */
  skipped?: boolean;
  /** Причина skipped/ok=false. */
  reason?: string;
}

/**
 * Провайдеры с определённым путём возврата: `PaymentProvider`
 * (`tbank`|`paykeeper`|`manual`) + forward-compat `gift` (ADR-P1-3, шаг 4). NB: не
 * равно реестру `PAYMENT_PROVIDERS` (там нет `gift`) — `gift` здесь заглушка.
 */
type RefundProvider = 'tbank' | 'paykeeper' | 'alfabank' | 'manual' | 'gift';

function isRefundProvider(v: string): v is RefundProvider {
  return (
    v === 'tbank' ||
    v === 'paykeeper' ||
    v === 'alfabank' ||
    v === 'manual' ||
    v === 'gift'
  );
}

/** Внутренний (без шлюза) возврат: реальный возврат делает сетл в вызывающем экшене. */
function internalRefund(reason: string): RefundDispatchResult {
  return { ok: true, skipped: true, status: null, isMock: false, reason };
}

/** Compile-time exhaustiveness: новый RefundProvider без case → ошибка типов здесь. */
function assertNever(x: never): never {
  throw new OrderError(
    'unsupported_payment_provider',
    `Возврат не поддержан для провайдера: ${String(x)}.`,
  );
}

/**
 * Маршрутизирует шлюзовой возврат по `orders.payment_provider` (ADR-P1-3).
 *
 * Возвращает `{ok:false}` → вызывающий НЕ метит заказ refunded (не врём про возврат).
 * Бросает `OrderError('unsupported_payment_provider')` для неизвестного НЕ-null
 * провайдера — безопасно, НЕ дефолтит в tbank.
 */
export async function dispatchRefund(
  input: RefundDispatchInput,
): Promise<RefundDispatchResult> {
  const provider = input.paymentProvider;

  // NULL = офлайн/COD: онлайн-шлюза для reverse нет. Внутренний сетл вернёт деньги
  // вручную. КРИТИЧНО: НЕ маршрутизируем в tbank (это списало бы Cancel в Т-Банке по
  // чужому/несуществующему PaymentId → отпущенный холд/деньги без возврата заказа).
  if (provider === null) {
    return internalRefund('offline_no_provider');
  }

  // Неизвестный НЕ-null провайдер: НЕ угадываем чужой шлюз (деньги) и НЕ дефолтим в
  // tbank. Безопасная ошибка → возврат заказа отклоняется, оператор разбирается.
  if (!isRefundProvider(provider)) {
    throw new OrderError(
      'unsupported_payment_provider',
      `Неизвестный платёжный провайдер «${provider}»: шлюзовой возврат не выполнен. ` +
        'Возврат заказа отклонён во избежание обращения к неверному платёжному шлюзу.',
    );
  }

  switch (provider) {
    case 'tbank':
      // Поведение tbank НЕ меняется: тот же вызов, тот же результат/аудит.
      return new TbankPaymentService().refundPayment(input);
    case 'paykeeper':
      return new PaykeeperPaymentService().refundPayment(input);
    case 'alfabank':
      return new AlfabankPaymentService().refundPayment(input);
    case 'manual':
      // Ручной/офлайн-платёж: шлюзового reverse нет — внутренний сетл вернёт деньги.
      return internalRefund('manual');
    case 'gift':
      // Возврат баланса сертификата ОРТОГОНАЛЕН платёжному refund и делается
      // releaseGiftTx во внутреннем сетле (settleRefundEffectsTx /
      // applyOrderStatusTransition), а не через шлюз. Здесь — внутренний skip.
      return internalRefund('gift_orthogonal');
    default:
      return assertNever(provider);
  }
}
