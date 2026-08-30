/**
 * Сервис модуля payments/ozon: создание заказа в эквайринге, разбор и обработка
 * уведомлений, сверка статуса (порт lib/payments/tbank/service.ts).
 *
 * ПУТЬ ОПЛАТЫ: /v1/createOrder → order.payLink → редирект покупателя.
 * Метод /v1/createPayment НЕ используется: он поддерживает payType только SBP,
 * то есть картой через него платить нельзя.
 *
 * ANTI-TAMPER: сумма НИКОГДА не берётся из запроса витрины — считается сервером
 * из orders.grand_total. Иначе покупатель мог бы оплатить заказ на свою цену.
 */

import { logger } from '@/lib/logger';
import type { Order, OrderItem, PaymentStatus } from '@/lib/orders/types';
import { getOzonConfig, isOzonMock, type OzonConfig } from './config';
import { ozonPost } from './client';
import { OzonError } from './errors';
import {
  signCreateOrder,
  signOrderLookup,
  signCancelOrder,
  notificationSign,
  safeEqualHex,
} from './sign';
import { mapWebhookStatus, mapOrderStatus, describeErrorCode } from './status-map';
import {
  recordNotification,
  setPaymentRefAndProvider,
  findOrderIdByPaymentRef,
} from './repository';
import type {
  InitPaymentResult,
  OzonCreateOrderRequest,
  OzonCreateOrderResponse,
  OzonItem,
  OzonNotification,
  OzonOrderStatusResponse,
} from './types';

const log = logger.child({ module: 'payments/ozon' });

/** Код рубля по ISO 4217 — единственная валюта, принимаемая Ozon. */
const CURRENCY_RUB = '643';

/**
 * Рубли-строка (NUMERIC) → копейки-целое.
 * Через строковый разбор, а не через float: 0.1 + 0.2 в двоичной плавающей
 * точке не равно 0.3, и на суммах заказа это даёт расхождение в копейку,
 * из-за которого банк отвергает заказ (сумма позиций ≠ общей сумме).
 */
export function rublesToKopecks(value: string | number): number {
  const s = String(value).trim();
  const neg = s.startsWith('-');
  const [intPart = '0', fracRaw = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = (fracRaw + '00').slice(0, 2);
  const kop = Number.parseInt(intPart, 10) * 100 + Number.parseInt(frac, 10);
  if (!Number.isFinite(kop)) return 0;
  return neg ? -kop : kop;
}

/** Копейки → строка рублей с двумя знаками (формат value для Ozon). */
export function kopecksToRubles(kop: number): string {
  const sign = kop < 0 ? '-' : '';
  const abs = Math.abs(Math.round(kop));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Результат обработки уведомления. */
export interface HandleNotificationResult {
  /** Уведомление принято к обработке (подпись верна). */
  accepted: boolean;
  /** Событие записано впервые (false → повтор). */
  inserted: boolean;
  /** Переход payment_status применён. */
  processed: boolean;
  /** Причина отказа/пропуска — для журнала. */
  reason?: string;
}

/**
 * Разбирает тело уведомления в известную форму.
 * Ozon шлёт идентификатор попытки то как transactionUid, то как transactionUID —
 * в спеке встречаются оба написания, поэтому читаем оба.
 */
export function parseNotification(raw: unknown): OzonNotification | null {
  if (raw === null || typeof raw !== 'object') return null;
  return raw as OzonNotification;
}

/** Идентификатор попытки оплаты из уведомления (с учётом обоих написаний). */
export function notificationTransactionUid(n: OzonNotification): string | null {
  const uid = n.transactionUid ?? n.transactionUID;
  if (typeof uid === 'string' && uid.length > 0) return uid;
  // Запасной вариант: устаревший числовой transactionID. Хуже как ключ
  // идемпотентности, но лучше, чем потерять событие целиком.
  if (n.transactionID !== undefined && n.transactionID !== null) return String(n.transactionID);
  return null;
}

/**
 * Убирает подпись из тела перед записью в журнал: в аудите она бесполезна,
 * а утечка облегчала бы подделку уведомлений.
 */
export function sanitizeNotification(n: OzonNotification): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(n as Record<string, unknown>) };
  delete copy.requestSign;
  return copy;
}

export class OzonPaymentService {
  private readonly cfg: OzonConfig;
  private readonly mock: boolean;

  constructor(source?: Record<string, string | undefined>) {
    this.cfg = getOzonConfig(source);
    this.mock = isOzonMock(source);
  }

  get isMock(): boolean {
    return this.mock;
  }

  /**
   * Собирает позиции чека из заказа. Доставка добавляется ОТДЕЛЬНОЙ позицией:
   * Ozon требует, чтобы сумма позиций сходилась с общей суммой заказа, иначе
   * заказ отвергается.
   *
   * Скидка промокода (discountTotal) уменьшает общую сумму, но не распределена
   * по позициям, поэтому при её наличии сумма позиций разошлась бы с итогом.
   * В этом случае возвращаем null и заказ уходит в сокращённом виде.
   */
  private buildItems(order: Order, items: OrderItem[]): OzonItem[] | null {
    const discountKop = rublesToKopecks(order.discountTotal);
    if (discountKop > 0) return null;

    const result: OzonItem[] = items.map((it) => ({
      name: it.nameSnapshot.slice(0, 250),
      price: { currencyCode: CURRENCY_RUB, value: kopecksToRubles(rublesToKopecks(it.unitPrice)) },
      quantity: it.quantity,
      vat: this.cfg.defaultVat,
      type: 'TYPE_PRODUCT' as const,
      extId: it.id,
    }));

    const deliveryKop = rublesToKopecks(order.deliveryTotal);
    if (deliveryKop > 0) {
      result.push({
        name: 'Доставка',
        price: { currencyCode: CURRENCY_RUB, value: kopecksToRubles(deliveryKop) },
        quantity: 1,
        vat: this.cfg.defaultVat,
        extId: `delivery-${order.id}`,
      });
    }

    // Контрольная сверка: сумма позиций обязана совпасть с итогом заказа.
    const sum = result.reduce(
      (acc, i) => acc + rublesToKopecks(i.price.value) * i.quantity,
      0,
    );
    const grand = rublesToKopecks(order.grandTotal);
    if (sum !== grand) {
      log.warn('ozon: сумма позиций не сошлась с итогом заказа — отправляем без состава', {
        orderNumber: order.number, sumKop: sum, grandKop: grand,
      });
      return null;
    }
    return result;
  }

  /**
   * Создаёт заказ в эквайринге и возвращает ссылку на оплату.
   *
   * Идемпотентность: extId = номер заказа. Повторный вызов с тем же extId
   * вернёт РАНЕЕ созданный заказ, а не создаст дубль — так устроен Ozon.
   */
  async initPayment(
    order: Order,
    items: OrderItem[],
    opts: { baseOrigin?: string; returnUrl?: string } = {},
  ): Promise<InitPaymentResult> {
    const amountKop = rublesToKopecks(order.grandTotal);
    if (amountKop <= 0) {
      throw new OzonError('Сумма заказа должна быть положительной.');
    }

    if (this.mock) {
      // MOCK: в сеть не ходим. Возвращаем внутренний адрес, чтобы demo-стенд
      // работал без боевого терминала. Реальных денег здесь нет.
      const origin = opts.baseOrigin ?? '';
      const url = opts.returnUrl ?? `${origin}/order-success.html?order=${encodeURIComponent(order.number)}`;
      log.warn('ozon: MOCK-режим — оплата ненастоящая, ключи не заданы', {
        orderNumber: order.number,
      });
      return { paymentUrl: url, paymentId: `mock-${order.id}`, status: 'STATUS_NEW', isMock: true };
    }

    const accessKey = this.cfg.accessKey!;
    const secretKey = this.cfg.secretKey!;

    const expiresAt = new Date(Date.now() + this.cfg.expiresMin * 60_000).toISOString();
    const fiscalizationType = this.cfg.fiscalizationEnabled ? this.cfg.fiscalizationType : '';
    const value = kopecksToRubles(amountKop);

    // Порядок полей подписи задан спекой и отличается для каждого метода.
    const requestSign = signCreateOrder({
      accessKey,
      expiresAt,
      extId: order.number,
      fiscalizationType,
      paymentAlgorithm: this.cfg.payAlgorithm,
      currencyCode: CURRENCY_RUB,
      value,
      secretKey,
    });

    const built = this.cfg.fiscalizationEnabled ? this.buildItems(order, items) : null;

    const body: OzonCreateOrderRequest = {
      accessKey,
      amount: { currencyCode: CURRENCY_RUB, value },
      paymentAlgorithm: this.cfg.payAlgorithm,
      requestSign,
      extId: order.number,
      expiresAt,
      // Фискализация требует состава корзины: в чеке по 54-ФЗ должны быть
      // позиции. Если состав собрать не удалось — сокращённый режим.
      mode: built ? 'MODE_FULL' : 'MODE_SHORTENED',
      enableFiscalization: this.cfg.fiscalizationEnabled,
    };
    if (built) body.items = built;
    if (this.cfg.fiscalizationEnabled) body.fiscalizationType = this.cfg.fiscalizationType;
    if (order.customerEmail) body.receiptEmail = order.customerEmail;
    if (this.cfg.successUrl) body.successUrl = this.cfg.successUrl;
    if (this.cfg.failUrl) body.failUrl = this.cfg.failUrl;
    if (this.cfg.notificationUrl) body.notificationUrl = this.cfg.notificationUrl;

    const res = await ozonPost<OzonCreateOrderResponse>(this.cfg.baseUrl, 'createOrder', body);
    const ozonOrder = res.order;
    const payLink = ozonOrder?.payLink;

    if (!ozonOrder?.id || !payLink) {
      log.error('ozon: createOrder не вернул payLink', { orderNumber: order.number });
      throw new OzonError('Эквайринг не вернул ссылку на оплату.');
    }

    await setPaymentRefAndProvider(order.id, ozonOrder.id);

    if (ozonOrder.isTestMode) {
      log.warn('ozon: заказ создан в ТЕСТОВОМ режиме — реальные карты не пройдут', {
        orderNumber: order.number,
      });
    }

    return {
      paymentUrl: payLink,
      paymentId: ozonOrder.id,
      status: ozonOrder.status ?? 'STATUS_NEW',
      isMock: false,
    };
  }

  /**
   * Проверяет подпись уведомления ключом нотификаций.
   *
   * Ключ нотификаций — ТРЕТИЙ, независимый секрет: если он не задан, принимать
   * уведомления нельзя вообще, иначе кто угодно пометит заказ оплаченным.
   */
  verifyNotification(n: OzonNotification): boolean {
    const notificationSecretKey = this.cfg.notificationSecretKey;
    const accessKey = this.cfg.accessKey;
    if (!notificationSecretKey || !accessKey) return false;
    if (!n.requestSign) return false;

    const amount = n.amount ?? '';
    const currencyCode = n.currencyCode ?? CURRENCY_RUB;

    // Уведомление по ЗАКАЗУ и по самостоятельной оплате подписываются по разным
    // формулам. Проверяем обе: какая сойдётся, та и верна.
    const asOrder = notificationSign({
      accessKey,
      orderID: n.orderID ?? '',
      transactionID: n.transactionID ?? '',
      extOrderID: n.extOrderID ?? '',
      amount,
      currencyCode,
      notificationSecretKey,
    });
    if (safeEqualHex(n.requestSign, asOrder)) return true;

    const asStandalone = notificationSign({
      accessKey,
      orderID: '',
      transactionID: '',
      extOrderID: n.extTransactionID ?? '',
      amount,
      currencyCode,
      notificationSecretKey,
    });
    return safeEqualHex(n.requestSign, asStandalone);
  }

  /**
   * Обрабатывает проверенное уведомление: находит заказ, пишет журнал и
   * применяет переход статуса оплаты — атомарно и идемпотентно.
   */
  async handleNotification(
    n: OzonNotification,
    ctx: { ip?: string | null } = {},
  ): Promise<HandleNotificationResult> {
    if (!this.verifyNotification(n)) {
      return { accepted: false, inserted: false, processed: false, reason: 'bad_signature' };
    }

    const transactionUid = notificationTransactionUid(n);
    if (!transactionUid) {
      return { accepted: true, inserted: false, processed: false, reason: 'no_transaction_uid' };
    }

    // Ищем заказ: сначала по нашему номеру (extOrderID), затем по идентификатору
    // заказа на стороне эквайринга.
    let orderId: string | null = null;
    const extOrderID = n.extOrderID?.trim();
    if (extOrderID) {
      const { getOrderByNumber } = await import('@/lib/orders/repository');
      const found = await getOrderByNumber(extOrderID);
      orderId = found?.order.id ?? null;
    }
    if (!orderId && n.orderID) {
      orderId = await findOrderIdByPaymentRef(n.orderID);
    }
    if (!orderId) {
      log.warn('ozon: уведомление о неизвестном заказе', {
        extOrderID: extOrderID ?? null, ozonOrderId: n.orderID ?? null,
      });
      return { accepted: true, inserted: false, processed: false, reason: 'order_not_found' };
    }

    const status = String(n.status ?? '');
    const nextStatus: PaymentStatus | null = mapWebhookStatus(status);

    const errorNote = describeErrorCode(n.errorCode);
    const comment = errorNote
      ? `Ozon: ${status} (${errorNote})`
      : `Ozon: ${status}`;

    const amountRaw = n.amount;
    const amountKop =
      amountRaw === undefined || amountRaw === null
        ? null
        : Number.parseInt(String(amountRaw), 10);

    const res = await recordNotification({
      log: {
        orderId,
        transactionUid,
        status,
        ozonOrderId: n.orderID ?? null,
        paymentMethod: n.paymentMethod ?? null,
        // Ozon присылает сумму уже в копейках — пересчёт не нужен.
        amountKop: Number.isFinite(amountKop) ? amountKop : null,
        errorCode: n.errorCode ?? null,
        errorMessage: n.errorMessage ?? null,
        isTest: n.testMode === 1,
        isMock: false,
        rawPayload: sanitizeNotification(n),
        ip: ctx.ip ?? null,
      },
      nextStatus,
      comment,
    });

    return { accepted: true, inserted: res.inserted, processed: res.processed };
  }

  /**
   * Сверяет статус заказа в эквайринге и применяет переход, если оплата
   * завершилась, а уведомление потерялось.
   */
  async reconcile(order: Order): Promise<{ status: string | null; applied: boolean }> {
    if (this.mock || !order.paymentRef) return { status: null, applied: false };

    const accessKey = this.cfg.accessKey!;
    const secretKey = this.cfg.secretKey!;

    const requestSign = signOrderLookup({
      id: order.paymentRef,
      extId: '',
      accessKey,
      secretKey,
    });

    const res = await ozonPost<OzonOrderStatusResponse>(this.cfg.baseUrl, 'getOrderStatus', {
      accessKey,
      id: order.paymentRef,
      requestSign,
    });

    const status = res.status ?? null;
    const next = mapOrderStatus(status);
    if (!next) return { status, applied: false };

    const { applyPaymentStatus } = await import('./repository');
    const applied = await applyPaymentStatus(order.id, next, `Ozon: сверка (${status})`);
    return { status, applied };
  }

  /** Отменяет неоплаченный заказ. Работает только в статусе ожидания оплаты. */
  async cancelOrder(ozonOrderId: string): Promise<void> {
    if (this.mock) return;
    const accessKey = this.cfg.accessKey!;
    const secretKey = this.cfg.secretKey!;
    const requestSign = signCancelOrder({ id: ozonOrderId, accessKey, secretKey });
    await ozonPost(this.cfg.baseUrl, 'cancelOrder', { accessKey, id: ozonOrderId, requestSign });
  }
}
