/**
 * Адаптеры конкретных эквайеров к единому контракту `PaymentProvider`.
 *
 * Оборачиваем, а не переписываем сервисы: они писались раньше общего интерфейса
 * и уже работают на боевых магазинах. Менять их сигнатуры задним числом опаснее,
 * чем добавить тонкий слой перевода имён (`cancelOrder` → `refundPayment` и т. п.).
 */

import type { Order, OrderItem } from '@/lib/orders/types';
import { PaymentService as TbankService, isTbankMock, toKopecks } from '@/lib/payments/tbank';
import { OzonPaymentService } from '@/lib/payments/ozon/service';
import { AtolPaymentService } from '@/lib/payments/atol/service';
import type {
  PaymentProvider,
  ProviderInitResult,
  ProviderRefundResult,
  ProviderReconcileResult,
} from '@/lib/payments/types';

/** Т-Банк: контракт совпадает почти один в один. */
export class TbankProviderAdapter implements PaymentProvider {
  readonly code = 'tbank';
  private readonly svc: TbankService;

  constructor(svc: TbankService = new TbankService()) {
    this.svc = svc;
  }

  isConfigured(): boolean {
    // mock-режим = боевые ключи не заданы (источник правды провайдера).
    return !isTbankMock();
  }

  async initPayment(
    order: Order,
    items: OrderItem[],
    opts: { baseOrigin?: string; returnUrl?: string },
  ): Promise<ProviderInitResult> {
    const r = await this.svc.initPayment(order, items, opts);
    return { paymentId: r.paymentId, paymentUrl: r.paymentUrl, status: r.status, isMock: r.isMock };
  }

  async refundPayment(input: {
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    paymentProvider: string | null;
    paymentRef: string | null;
    amountKop: number;
  }): Promise<ProviderRefundResult> {
    const r = await this.svc.refundPayment(input);
    return { ok: r.ok, skipped: r.skipped, status: r.status, isMock: r.isMock, reason: r.reason };
  }

  async reconcile(order: Order): Promise<ProviderReconcileResult> {
    // Сверять нечего, пока эквайер не выдал идентификатор платежа.
    if (!order.paymentRef) return { status: null, applied: false };
    const r = await this.svc.reconcilePayment({
      orderId: order.id,
      orderNumber: order.number,
      paymentId: order.paymentRef,
      amountKop: toKopecks(order.grandTotal),
    });
    return { status: r.status ?? null, applied: Boolean(r.applied) };
  }
}

/** Озон Банк: имена методов другие — переводим. */
export class OzonProviderAdapter implements PaymentProvider {
  readonly code = 'ozon';
  private readonly svc: OzonPaymentService;

  constructor(svc: OzonPaymentService = new OzonPaymentService()) {
    this.svc = svc;
  }

  isConfigured(): boolean {
    return !this.svc.isMock;
  }

  async initPayment(
    order: Order,
    items: OrderItem[],
    opts: { baseOrigin?: string; returnUrl?: string },
  ): Promise<ProviderInitResult> {
    const r = await this.svc.initPayment(order, items, opts);
    return { paymentId: r.paymentId, paymentUrl: r.paymentUrl, status: r.status, isMock: r.isMock };
  }

  /**
   * У Озона нет операции частичного возврата в текущем провайдере — есть отмена
   * заказа. Возвращаем `skipped` с внятной причиной, а НЕ бросаем исключение:
   * иначе админка не сможет отменить заказ вовсе (см. комментарий в types.ts).
   */
  async refundPayment(input: {
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    paymentProvider: string | null;
    paymentRef: string | null;
    amountKop: number;
  }): Promise<ProviderRefundResult> {
    const isMock = this.svc.isMock;
    if (input.paymentProvider !== this.code || !input.paymentRef) {
      return { ok: true, skipped: true, status: null, isMock, reason: 'no_gateway' };
    }
    if (input.paymentStatus !== 'paid' && input.paymentStatus !== 'authorized') {
      return { ok: true, skipped: true, status: null, isMock, reason: 'not_captured' };
    }
    try {
      await this.svc.cancelOrder(input.paymentRef);
      return { ok: true, status: 'CANCELLED', isMock };
    } catch (err) {
      return {
        ok: false,
        status: null,
        isMock,
        reason: err instanceof Error ? err.message : 'cancel_failed',
      };
    }
  }

  async reconcile(order: Order): Promise<ProviderReconcileResult> {
    const r = await this.svc.reconcile(order);
    return { status: r.status, applied: r.applied };
  }
}

/**
 * АТОЛ Pay Ecom: имена методов ближе к Озону, но с одним важным отличием.
 *
 * 🔴 У АТОЛа отмена и возврат — ОДНА ручка `POST /payments/{orderId}/cancel`,
 * принимающая сумму. Поэтому, в отличие от Озона, возврат здесь настоящий:
 * передаём `amountKop` и умеем вернуть часть суммы. Сервис сам решает, что
 * именно вызвать у API; адаптеру достаточно передать сумму.
 */
export class AtolProviderAdapter implements PaymentProvider {
  readonly code = 'atol';
  private readonly svc: AtolPaymentService;

  constructor(svc: AtolPaymentService = new AtolPaymentService()) {
    this.svc = svc;
  }

  isConfigured(): boolean {
    // mock-режим = боевой токен не задан (источник правды провайдера).
    return !this.svc.isMock;
  }

  async initPayment(
    order: Order,
    items: OrderItem[],
    opts: { baseOrigin?: string; returnUrl?: string },
  ): Promise<ProviderInitResult> {
    const r = await this.svc.initPayment(order, items, opts);
    return { paymentId: r.paymentId, paymentUrl: r.paymentUrl, status: r.status, isMock: r.isMock };
  }

  /**
   * Возврат денег. Оба гарда ниже — не перестраховка, а требование контракта
   * (см. types.ts): админка обязана уметь отменить заказ, оплаченный наличными
   * или по счёту, и заказ, оплаченный ЧЕРЕЗ ДРУГОГО эквайера. Поэтому «возврат
   * не нужен» возвращается как `skipped: true`, а НЕ как исключение — иначе
   * отмена такого заказа в админке падала бы с ошибкой шлюза.
   */
  async refundPayment(input: {
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    paymentProvider: string | null;
    paymentRef: string | null;
    amountKop: number;
  }): Promise<ProviderRefundResult> {
    const isMock = this.svc.isMock;
    if (input.paymentProvider !== this.code || !input.paymentRef) {
      return { ok: true, skipped: true, status: null, isMock, reason: 'no_gateway' };
    }
    if (input.paymentStatus !== 'paid' && input.paymentStatus !== 'authorized') {
      return { ok: true, skipped: true, status: null, isMock, reason: 'not_captured' };
    }
    try {
      // Сумму передаём всегда: та же ручка обслуживает и полный, и частичный
      // возврат, а «сколько вернуть» знает только вызывающая сторона.
      await this.svc.refund({ paymentRef: input.paymentRef, amountKop: input.amountKop });
      return { ok: true, status: 'CANCELLED', isMock };
    } catch (err) {
      // Отказ ШЛЮЗА — это ok:false: деньги остались у эквайера, и оператор
      // обязан увидеть причину, а не «возврат выполнен».
      return {
        ok: false,
        status: null,
        isMock,
        reason: err instanceof Error ? err.message : 'refund_failed',
      };
    }
  }

  async reconcile(order: Order): Promise<ProviderReconcileResult> {
    const r = await this.svc.reconcile(order);
    return { status: r.status, applied: r.applied };
  }
}
