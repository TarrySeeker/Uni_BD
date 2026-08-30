/**
 * ЕДИНЫЙ КОНТРАКТ ПЛАТЁЖНОГО ПРОВАЙДЕРА (мультитенантность эквайринга).
 *
 * 🔴 ЗАЧЕМ. Эквайер у каждого магазина СВОЙ: Т-Банк, Озон Банк, PayKeeper,
 * приём по счёту. До этого слоя провайдер добавлялся КОПИРОВАНИЕМ: свои роуты
 * (`/payments/<name>/init`, `/payments/<name>/webhook`) и свой сервис со своими
 * именами методов (`refundPayment` против `cancelOrder`, `handleWebhook` против
 * `handleNotification`). Следствия, которые уже стреляли на боевых магазинах:
 *
 *   • бизнес-логика заказа импортировала Т-Банк НАПРЯМУЮ
 *     (`import { PaymentService } from '@/lib/payments/tbank'`), поэтому возврат
 *     денег из админки работал ТОЛЬКО у магазина на Т-Банке; у остальных
 *     `refundPayment` видел `paymentProvider !== 'tbank'` и молча отвечал
 *     «возврат не требуется» — при реально списанных деньгах;
 *   • витрина каждого магазина обязана была знать ИМЯ эквайера, чтобы попасть
 *     в нужный URL инициации;
 *   • подключение нового эквайера означало копирование роутов и риск, что
 *     половину мест забудут (так и вышло).
 *
 * Этот модуль задаёт ОДИН интерфейс, который реализует каждый провайдер, и
 * позволяет остальному коду не знать, какой эквайер включён в магазине.
 */

import type { Order, OrderItem } from '@/lib/orders/types';

/** Код провайдера (совпадает с `orders.payment_provider`). */
export type PaymentProviderCode = string;

/** Результат инициации оплаты — единый для всех эквайеров. */
export interface ProviderInitResult {
  /** Идентификатор платежа на стороне эквайера (пишется в orders.payment_ref). */
  paymentId: string;
  /** Куда отправить покупателя платить. */
  paymentUrl: string;
  /** Статус в терминах эквайера (для журнала; трактовать через status-map). */
  status: string | null;
  /** Провайдер работает в mock-режиме (боевые ключи не заданы). */
  isMock: boolean;
}

/** Результат возврата денег. */
export interface ProviderRefundResult {
  /** Возврат выполнен ИЛИ не требовался. `false` — шлюз отказал. */
  ok: boolean;
  /** Возврат не потребовался (COD/manual, деньги не захвачены, чужой провайдер). */
  skipped?: boolean;
  status: string | null;
  isMock: boolean;
  /** Причина отказа/пропуска — для аудита и сообщения оператору. */
  reason?: string | null;
}

/** Результат сверки статуса платежа с эквайером. */
export interface ProviderReconcileResult {
  status: string | null;
  /** Статус заказа был изменён по итогам сверки. */
  applied: boolean;
}

/**
 * Контракт эквайера. Реализуется адаптером над конкретным сервисом провайдера,
 * а не самим сервисом: провайдеры писались раньше этого интерфейса и менять их
 * сигнатуры задним числом опаснее, чем обернуть.
 */
export interface PaymentProvider {
  /** Код провайдера: 'tbank' | 'ozon' | 'paykeeper' | … */
  readonly code: PaymentProviderCode;

  /** Провайдер сконфигурирован боевыми ключами (иначе mock/демо). */
  isConfigured(): boolean;

  /** Создать платёж и получить ссылку для покупателя. */
  initPayment(
    order: Order,
    items: OrderItem[],
    opts: { baseOrigin?: string; returnUrl?: string },
  ): Promise<ProviderInitResult>;

  /**
   * Вернуть деньги. Обязан сам решить, что возврат не нужен (не его заказ,
   * деньги не захвачены) и вернуть `skipped: true` — вместо исключения:
   * админка обязана уметь отменить заказ, оплаченный наличными.
   */
  refundPayment(input: {
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    paymentProvider: string | null;
    paymentRef: string | null;
    amountKop: number;
  }): Promise<ProviderRefundResult>;

  /**
   * Сверить статус платежа с эквайером (фоллбэк, если вебхук не дошёл).
   * Провайдер без такой возможности возвращает `applied: false`.
   */
  reconcile?(order: Order): Promise<ProviderReconcileResult>;
}
