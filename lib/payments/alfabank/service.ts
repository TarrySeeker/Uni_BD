/**
 * PaymentService Альфа-Банк — инициация оплаты и приём колбэка (порт
 * paykeeper/service.ts + tbank/service.ts на REST-модель RBS).
 *
 * initPayment(order) — регистрирует заказ (register.do): amount = toMinor(grand_total)
 *   В КОПЕЙКАХ (СЕРВЕР, anti-tamper ADR-010, не из запроса витрины). В mock — фейковый
 *   orderId (mdOrder) + внутренний demo-URL (formUrl); в боевом — POST register.do.
 *   Сохраняет orderId + payment_provider='alfabank' (setPaymentRefAndProvider). Куда
 *   редиректим покупателя — res.paymentUrl (= formUrl).
 *
 * handleCallback(params, ip) — КЛЮЧЕВОЕ (callbackUrl, GET query params):
 *   1) checksum: если ALFABANK_CALLBACK_SECRET задан — верифицируем (verifyCallbackChecksum),
 *      невалид → verified:false; если секрет НЕ задан (mock/не настроен) — пропускаем
 *      проверку (verified:true);
 *   2) поиск заказа по payment_ref=mdOrder с фолбэком orders.number=orderNumber;
 *   3) маппинг operation+status → payment_status (mapCallbackOperation);
 *   4) АТОМАРНАЯ идемпотентная обработка recordWebhookEvent (UNIQUE (order_ref, status));
 *      дубликат → без повторных эффектов.
 *
 * confirmMockPayment / reconcilePayment / refundPayment — как в tbank/paykeeper.
 */

import { autoIssueGiftsForPaidOrder } from '@/lib/gift-certificates/auto-issue';
import { getOrderByNumber } from '@/lib/orders/repository';
import { isOrderPayable } from '@/lib/orders/status';
import { toMinor } from '@/lib/orders/money';
import type { Order, OrderItem } from '@/lib/orders/types';
import { AlfabankManager, getAlfabankManager } from './manager';
import { AlfabankError } from './errors';
import { mapCallbackOperation, mapOrderStatus } from './status-map';
import { verifyCallbackChecksum } from './token';
import {
  recordWebhookEvent,
  setPaymentRefAndProvider,
  findOrderIdByRef,
  insertPaymentLog,
  type RecordWebhookResult,
} from './repository';
import type {
  AlfabankCallbackParams,
  HandleCallbackResult,
  InitPaymentResult,
} from './types';

/** Результат сверки платежа через getOrderStatusExtended (reconcilePayment). */
export interface ReconcilePaymentResult {
  /** Шлюз ответил корректно (или mock). false → транспортная ошибка. */
  ok: boolean;
  /** Сырой числовой orderStatus Альфа-Банка (строкой) или null. */
  status: string | null;
  /** Переход payment_status применён в этой сверке. */
  applied: boolean;
  isMock: boolean;
  /** Причина ok=false. */
  reason?: string;
}

/** Результат шлюзового возврата через refund.do (refundPayment). */
export interface RefundPaymentResult {
  /** Возврат принят шлюзом (или корректно пропущен). false → шлюз отказал. */
  ok: boolean;
  /** Сырой errorCode Альфа-Банка после refund (или null). */
  status: string | null;
  isMock: boolean;
  /** true → шлюзовой возврат не требовался (COD/manual/не захвачен). */
  skipped?: boolean;
  /** Причина skipped/ok=false (no_gateway/not_captured/errorCode). */
  reason?: string;
}

/** Мягкий перевод рублёвой строки → копейки (не бросает на «грязной» сумме). */
function toKopecksSafe(value: string | number): number {
  try {
    return toMinor(value);
  } catch {
    return 0;
  }
}

// =============================================================================
// parseCallback — ЧИСТАЯ. Нормализация query-полей колбэка → строгие posted-строки.
// =============================================================================

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Нормализует произвольный набор query-полей колбэка Альфа-Банка в строгие строки
 * (mdOrder/orderNumber/operation/status/checksum) + прочие поля (rest, для HMAC).
 * Толерантна к форме. ЧИСТАЯ. Значения НЕ переформатируются (участвуют в HMAC как есть).
 */
export function parseCallback(fields: Record<string, unknown>): AlfabankCallbackParams {
  const known = new Set(['mdOrder', 'orderNumber', 'operation', 'status', 'checksum']);
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!known.has(k)) rest[k] = str(v);
  }
  return {
    mdOrder: str(fields.mdOrder),
    orderNumber: str(fields.orderNumber),
    operation: str(fields.operation),
    status: str(fields.status),
    checksum: str(fields.checksum),
    rest,
  };
}

/**
 * Собирает ПОЛНЫЙ плоский набор параметров колбэка для HMAC-проверки: известные
 * поля + rest + checksum. verifyCallbackChecksum читает checksum из этого набора и
 * СЧИТАЕТ HMAC по остальным полям (signCallback исключает checksum из источника
 * подписи). Поэтому checksum ДОЛЖЕН присутствовать здесь (иначе provided=undefined
 * → verify всегда false).
 */
function callbackHmacParams(params: AlfabankCallbackParams): Record<string, string> {
  return {
    ...params.rest,
    mdOrder: params.mdOrder,
    orderNumber: params.orderNumber,
    operation: params.operation,
    status: params.status,
    checksum: params.checksum,
  };
}

/** Маскирует checksum перед записью в лог (аудит/replay безопасны). */
export function sanitizeCallback(params: AlfabankCallbackParams): Record<string, unknown> {
  return {
    mdOrder: params.mdOrder,
    orderNumber: params.orderNumber,
    operation: params.operation,
    status: params.status,
    ...params.rest,
  };
}

// =============================================================================
// PaymentService — init + callback.
// =============================================================================

/**
 * ПОСТ-КОММИТНЫЙ автовыпуск подарочных сертификатов по оплаченному заказу (ТЗ п.11).
 *
 * ВЫЗЫВАТЬ СТРОГО ПОСЛЕ `await recordWebhookEvent`, то есть ПОСЛЕ КОММИТА. Внутри
 * той транзакции (лог события + переход в paid + пометка processed) любой throw
 * откатил бы САМ ФАКТ ОПЛАТЫ, а повторная доставка события была бы отсечена
 * уникальным ключом лога: деньги приняты, а заказ навсегда pending.
 *
 * По той же причине ошибка выпуска ГЛОТАЕТСЯ: ответ провайдеру обязан остаться
 * успешным, иначе банк начнёт ретраить событие. Невыпущенное подхватит крон-сверка.
 */
async function autoIssueGiftsAfterCommit(
  orderId: string,
  result: RecordWebhookResult,
): Promise<void> {
  if (!(result.inserted && result.applied && result.paymentStatus === 'paid')) return;
  try {
    await autoIssueGiftsForPaidOrder(orderId);
  } catch (err) {
    console.warn(
      `[alfabank] автовыпуск подарочных сертификатов не удался (order=${orderId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export class PaymentService {
  constructor(private readonly manager: AlfabankManager = getAlfabankManager()) {}

  /**
   * Инициирует платёж по заказу (register.do). Amount — КОПЕЙКИ из grand_total
   * (сервер, anti-tamper). В mock — фейковый orderId + внутренний formUrl; в боевом —
   * POST register.do. Сохраняет orderId + payment_provider='alfabank'. baseOrigin
   * (опц.) абсолютизирует mock-URL. returnUrl — куда вернуть покупателя после оплаты.
   */
  async initPayment(
    order: Order,
    _items: OrderItem[] = [],
    opts: { baseOrigin?: string; returnUrl?: string } = {},
  ): Promise<InitPaymentResult> {
    void _items;
    const cfg = this.manager.config;
    const amountKop = toKopecksSafe(order.grandTotal);
    if (amountKop <= 0) {
      throw new AlfabankError(
        'alfabank_invalid_amount',
        `Некорректная сумма заказа: ${order.grandTotal}.`,
      );
    }
    // Гард оплачиваемости (backend-инвариант): отменённый/возвращённый заказ и уже
    // оплаченный/возвращённый платёж оплачивать нельзя. Допускает ретрай failed.
    if (!isOrderPayable(order.status, order.paymentStatus)) {
      throw new AlfabankError(
        'alfabank_order_not_payable',
        `Заказ ${order.number} нельзя оплатить (статус заказа «${order.status}», оплаты «${order.paymentStatus}»).`,
      );
    }

    // ---- MOCK-режим: без сети, фейковый orderId + внутренний formUrl. ----
    if (this.manager.isMock) {
      const res = this.manager.mock.mockRegisterOrder({
        orderNumber: order.number,
        amountKop,
        baseOrigin: opts.baseOrigin,
        returnUrl: opts.returnUrl,
      });
      await setPaymentRefAndProvider(order.id, res.orderId);
      return {
        paymentId: res.orderId,
        paymentUrl: res.formUrl,
        status: res.status,
        isMock: true,
      };
    }

    // ---- Боевой/тестовый контур: реальная регистрация заказа. ----
    // returnUrl обязателен для register.do: приоритет opts.returnUrl (витрина), затем
    // config.returnUrl (env). Без него register.do отклонит запрос.
    const returnUrl = opts.returnUrl ?? cfg.returnUrl;
    if (!returnUrl) {
      throw new AlfabankError(
        'alfabank_no_return_url',
        'register.do требует returnUrl (задайте ALFABANK_RETURN_URL или передайте returnUrl).',
      );
    }
    const res = await this.manager.client.registerOrder({
      orderNumber: order.number,
      amountKop,
      returnUrl,
      failUrl: cfg.failUrl ?? undefined,
      description: cfg.description ?? `Заказ ${order.number}`,
    });
    await setPaymentRefAndProvider(order.id, res.orderId);
    return {
      paymentId: res.orderId,
      paymentUrl: res.formUrl,
      status: 'registered',
      isMock: false,
    };
  }

  /**
   * Обрабатывает колбэк Альфа-Банка (callbackUrl) с (опц.) проверкой checksum и
   * АТОМАРНОЙ идемпотентной обработкой. checksum проверяется ТОЛЬКО если задан
   * ALFABANK_CALLBACK_SECRET; иначе (mock/не настроен) — событие принимается без
   * подписи. Запись лога + применение статуса + пометка processed — в ОДНОЙ транзакции
   * (recordWebhookEvent).
   *
   * Возвращает { verified, processed, duplicate, paymentStatus }.
   */
  async handleCallback(
    params: AlfabankCallbackParams,
    ip?: string | null,
  ): Promise<HandleCallbackResult> {
    const cfg = this.manager.config;

    // 1) checksum — ГЛАВНАЯ защита, НО НЕОБЯЗАТЕЛЬНА (задаётся симметричным ключом в
    //    ЛК Альфа-Банка). Если секрет задан → верифицируем; невалид → verified:false.
    //    Если секрет НЕ задан (mock/не настроен) → проверку пропускаем (verified:true).
    if (cfg.callbackSecret) {
      const ok = verifyCallbackChecksum(callbackHmacParams(params), cfg.callbackSecret);
      if (!ok) {
        return { verified: false, processed: false, duplicate: false, paymentStatus: null };
      }
    }

    if (!params.mdOrder && !params.orderNumber) {
      // Нет ни mdOrder, ни номера — обработать нечего.
      return { verified: true, processed: false, duplicate: false, paymentStatus: null };
    }

    // 2) Поиск заказа: приоритет payment_ref=mdOrder, фолбэк orders.number=orderNumber.
    let orderId: string | null = params.mdOrder ? await findOrderIdByRef(params.mdOrder) : null;
    if (!orderId && params.orderNumber) {
      const o = await getOrderByNumber(params.orderNumber);
      orderId = o?.order.id ?? null;
    }
    if (!orderId) {
      console.warn(
        `[alfabank] callback: заказ не найден (mdOrder=${params.mdOrder}, orderNumber=${params.orderNumber}).`,
      );
      return { verified: true, processed: false, duplicate: false, paymentStatus: null };
    }

    // 3) Маппинг operation+status → payment_status. Неуспех (status != '1') → null
    //    (переход не применяется, событие лишь логируется).
    const next = mapCallbackOperation(params.operation, params.status);
    const logStatus = `${params.operation || 'unknown'}:${params.status || '0'}`;

    // 4) АТОМАРНАЯ идемпотентная обработка (UNIQUE (order_ref, status)). order_ref
    //    обязателен для ключа — берём mdOrder (если пуст — фолбэк на orderNumber).
    const orderRef = params.mdOrder || params.orderNumber;
    const result = await recordWebhookEvent({
      log: {
        orderId,
        orderRef,
        status: logStatus,
        amountKop: null,
        isMock: this.manager.isMock,
        rawPayload: { source: 'callback', ...sanitizeCallback(params), ip: ip ?? null },
      },
      nextStatus: next,
      comment: `alfabank-callback:${logStatus}`,
    });
    // ПОСЛЕ КОММИТА: подарочные сертификаты по оплаченному заказу (ТЗ п.11).
    await autoIssueGiftsAfterCommit(orderId, result);
    const { inserted, processed } = result;
    if (!inserted) {
      // Дубликат: уже обработано — эффекты не повторяем.
      return { verified: true, processed: false, duplicate: true, paymentStatus: null };
    }

    return { verified: true, processed, duplicate: false, paymentStatus: next };
  }

  /**
   * DEMO-подтверждение mock-платежа (СТРОГО mock-режим, стенд без боевых ключей).
   * В mock checksum-секрет обычно отсутствует; эта точка имитирует успешную оплату
   * (deposited), чтобы demo доходило до paid. В БОЕВОМ режиме — РЕФЬЮЗ. Идемпотентно
   * через recordWebhookEvent (UNIQUE (order_ref, status)).
   */
  async confirmMockPayment(
    orderNumber: string,
    paymentId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.manager.isMock) return { ok: false, reason: 'not_mock' };
    if (!orderNumber || !paymentId) return { ok: false, reason: 'bad_request' };
    const found = await getOrderByNumber(orderNumber);
    if (!found) return { ok: false, reason: 'order_not_found' };
    // Привязка к инициированному платежу: paymentId обязан совпадать с payment_ref,
    // записанным при initPayment. Иначе demo помечала бы оплаченным ЛЮБОЙ заказ по
    // номеру. payment_ref = mock-orderId (непредсказуем), его знает лишь инициатор.
    if (!found.order.paymentRef || paymentId !== found.order.paymentRef) {
      return { ok: false, reason: 'payment_ref_mismatch' };
    }
    const result = await recordWebhookEvent({
      log: {
        orderId: found.order.id,
        orderRef: paymentId,
        status: 'deposited:1',
        amountKop: toKopecksSafe(found.order.grandTotal),
        isMock: true,
        rawPayload: { mock: true, source: 'mock-pay-demo', orderNumber, paymentId },
      },
      nextStatus: mapCallbackOperation('deposited', '1'),
      comment: 'mock-pay-demo:deposited',
    });
    await autoIssueGiftsAfterCommit(found.order.id, result);
    return { ok: true };
  }

  /**
   * СВЕРКА статуса через getOrderStatusExtended (фолбэк потерянного колбэка). Дёргает
   * getOrderStatusExtended.do (в mock — mockGetOrderStatus), маппит числовой
   * orderStatus → payment_status и АТОМАРНО+ИДЕМПОТЕНТНО доводит статус заказа через
   * recordWebhookEvent. amountKop — СЕРВЕРНЫЙ (из grand_total воркером).
   */
  async reconcilePayment(input: {
    orderId: string;
    orderNumber: string;
    paymentId: string;
    amountKop?: number;
  }): Promise<ReconcilePaymentResult> {
    const isMock = this.manager.isMock;

    let orderStatus: number | null;
    if (isMock) {
      orderStatus = this.manager.mock.mockGetOrderStatus(input.paymentId).orderStatus;
    } else {
      try {
        const res = await this.manager.client.getOrderStatus(input.paymentId);
        orderStatus = res.orderStatus;
      } catch (err) {
        return {
          ok: false,
          status: null,
          applied: false,
          isMock: false,
          reason: err instanceof AlfabankError ? err.code : 'getstatus_failed',
        };
      }
    }

    const statusStr = orderStatus === null ? null : String(orderStatus);
    const next = mapOrderStatus(orderStatus);
    const result = await recordWebhookEvent({
      log: {
        orderId: input.orderId,
        orderRef: input.paymentId,
        status: `orderStatus:${statusStr ?? 'unknown'}`,
        amountKop: input.amountKop ?? null,
        isMock,
        rawPayload: { source: 'reconcile-status', orderNumber: input.orderNumber, orderStatus },
      },
      nextStatus: next,
      comment: `reconcile-status:${statusStr}`,
    });
    await autoIssueGiftsAfterCommit(input.orderId, result);
    return { ok: true, status: statusStr, applied: result.processed, isMock };
  }

  /**
   * ШЛЮЗОВОЙ ВОЗВРАТ денег через refund.do. ВЫЗЫВАЕТСЯ экшеном refundOrder ДО смены
   * статуса заказа. Метод ТОЛЬКО дёргает шлюз (refund.do; в mock — mockRefund) и пишет
   * аудит-лог (insertPaymentLog) — payment_status он НЕ меняет (внутренний сетл делает
   * вызывающий экшен). Реальный refunded-колбэк, который придёт позже, идемпотентен.
   *
   * Пропуски (ok:true, skipped:true): провайдер не alfabank / нет payment_ref (COD/manual)
   * ИЛИ платёж не захвачен (payment_status не paid/authorized).
   */
  async refundPayment(input: {
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    paymentProvider: string | null;
    paymentRef: string | null;
    amountKop: number;
  }): Promise<RefundPaymentResult> {
    const isMock = this.manager.isMock;

    // COD/manual или нет orderId — шлюзовой возврат не требуется.
    if (input.paymentProvider !== 'alfabank' || !input.paymentRef) {
      return { ok: true, skipped: true, status: null, isMock, reason: 'no_gateway' };
    }
    // Деньги не захвачены (pending/failed/refunded) — возвращать нечего.
    if (input.paymentStatus !== 'paid' && input.paymentStatus !== 'authorized') {
      return { ok: true, skipped: true, status: null, isMock, reason: 'not_captured' };
    }

    let errorCode: string;
    if (isMock) {
      errorCode = this.manager.mock.mockRefund({
        authorizedOnly: input.paymentStatus === 'authorized',
      }).errorCode;
    } else {
      const res = await this.manager.client.refund(input.paymentRef, input.amountKop);
      errorCode = res.errorCode;
    }

    if (errorCode !== '0') {
      return { ok: false, status: errorCode, isMock, reason: errorCode };
    }

    // Аудит факта шлюзового возврата (идемпотентно; payment_status НЕ меняем). Ключ
    // (order_ref, status) синтетический 'admin-refund' — чтобы аудит-строка НЕ заняла
    // ключ реального 'refunded:1'-колбэка, который позже доведёт payment_status='refunded'.
    await insertPaymentLog({
      orderId: input.orderId,
      orderRef: input.paymentRef,
      status: 'admin-refund',
      amountKop: input.amountKop,
      isMock,
      rawPayload: { source: 'admin-refund', orderNumber: input.orderNumber, errorCode },
    });
    return { ok: true, status: errorCode, isMock };
  }
}
