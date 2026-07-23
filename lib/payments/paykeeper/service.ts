/**
 * PaymentService PayKeeper — инициация оплаты и приём колбэка (docs/24 §2, порт
 * lib/payments/tbank/service.ts на ИНВОЙСНУЮ модель).
 *
 * initPayment(order) — выставляет счёт: pay_amount = normalizeMoney(grand_total) В
 *   РУБЛЯХ (СЕРВЕР, anti-tamper ADR-010, не из запроса витрины). В mock — фейковый
 *   invoice_id + внутренний demo-URL; в боевом — getToken → POST invoice. Сохраняет
 *   invoice_id + payment_provider='paykeeper' на заказе (setPaymentRefAndProvider).
 *
 * handleCallback(params, ip) — КЛЮЧЕВОЕ (docs/24 §2):
 *   1) проверка подписи key = md5(id+sum+clientid+orderid+secret) (главная защита);
 *      невалид → verified:false, ack:null (роут → не-OK);
 *   2) поиск заказа по payment_ref=id с фолбэком orders.number=orderid;
 *   3) синтетический статус 'PAID' (колбэк несёт лишь факт успешной оплаты) → map;
 *   4) АТОМАРНАЯ идемпотентная обработка recordWebhookEvent (UNIQUE (invoice_id,
 *      status), ON CONFLICT DO NOTHING); дубликат → без повторных эффектов;
 *   5) на ЛЮБОМ верифицированном событии (в т.ч. заказ не найден / дубликат)
 *      возвращает ack = `OK `+md5(id+secret) — как боевой carre (PayKeeper обязан
 *      получить OK, иначе ретраит до 50 раз).
 *
 * Чистая проверка подписи (token.ts) тестируется отдельно; БД-зависимый
 * handleCallback — с моком репозитория / интеграционно.
 */

import { autoIssueGiftsForPaidOrder } from '@/lib/gift-certificates/auto-issue';
import { getOrderByNumber } from '@/lib/orders/repository';
import { isOrderPayable } from '@/lib/orders/status';
import { normalizeMoney, toMinor } from '@/lib/orders/money';
import type { Order, OrderItem } from '@/lib/orders/types';
import { PaykeeperManager, getPaykeeperManager } from './manager';
import { PaykeeperError } from './errors';
import { mapPaykeeperStatus } from './status-map';
import { verifyCallbackSignature, buildCallbackAck } from './token';
import {
  recordWebhookEvent,
  type RecordWebhookResult,
  setPaymentRefAndProvider,
  findOrderIdByInvoiceId,
  getOrderGrandTotalById,
} from './repository';
import type {
  HandleCallbackResult,
  InitPaymentResult,
  InvoiceStatusResult,
  PaykeeperCallbackParams,
  PaykeeperCartItem,
} from './types';

/** Результат сверки платежа через getInvoiceStatus (reconcilePayment). */
export interface ReconcilePaymentResult {
  /** Шлюз ответил корректно (или mock). false → транспортная ошибка. */
  ok: boolean;
  /** Сырой статус PayKeeper (или null). */
  status: string | null;
  /** Переход payment_status применён в этой сверке. */
  applied: boolean;
  isMock: boolean;
  /** Причина ok=false. */
  reason?: string;
}

/** Результат шлюзового возврата (refundPayment, MVP). */
export interface RefundPaymentResult {
  /** Возврат принят (или корректно пропущен). */
  ok: boolean;
  status: string | null;
  isMock: boolean;
  /** true → шлюзовой возврат не выполнялся (в MVP всегда — reverse не реализован). */
  skipped?: boolean;
  /** Причина skipped/ok=false. */
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
// parseCallback — ЧИСТАЯ. Нормализация form-полей колбэка → строгие posted-строки.
// =============================================================================

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Нормализует произвольный набор form-полей колбэка в строгие posted-строки
 * (id/sum/clientid/orderid/key). Толерантна к форме. ЧИСТАЯ. ВАЖНО: значения НЕ
 * переформатируются (sum остаётся сырой строкой — участвует в подписи как есть).
 */
export function parseCallback(fields: Record<string, unknown>): PaykeeperCallbackParams {
  return {
    id: str(fields.id),
    sum: str(fields.sum),
    clientid: str(fields.clientid),
    orderid: str(fields.orderid),
    key: str(fields.key),
  };
}

/** Маскирует секрет/подпись перед записью в лог (аудит/replay безопасны). */
export function sanitizeCallback(params: PaykeeperCallbackParams): Record<string, unknown> {
  const { key: _key, ...rest } = params;
  void _key;
  return rest;
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
      `[paykeeper] автовыпуск подарочных сертификатов не удался (order=${orderId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export class PaymentService {
  constructor(private readonly manager: PaykeeperManager = getPaykeeperManager()) {}

  /**
   * Инициирует платёж по заказу (docs/24 §2). pay_amount — РУБЛИ из grand_total
   * (сервер, anti-tamper). В mock — фейковый invoice_id + demo-URL; в боевом —
   * getToken → POST invoice. Сохраняет invoice_id + payment_provider='paykeeper'.
   * baseOrigin (опц.) абсолютизирует mock-URL.
   */
  async initPayment(
    order: Order,
    items: OrderItem[] = [],
    opts: { baseOrigin?: string; returnUrl?: string } = {},
  ): Promise<InitPaymentResult> {
    const cfg = this.manager.config;
    const payAmount = normalizeMoney(order.grandTotal);
    if (toKopecksSafe(order.grandTotal) <= 0) {
      throw new PaykeeperError(
        'paykeeper_invalid_amount',
        `Некорректная сумма заказа: ${order.grandTotal}.`,
      );
    }
    // Гард оплачиваемости (backend-инвариант): отменённый/возвращённый заказ и уже
    // оплаченный/возвращённый платёж оплачивать нельзя. Допускает ретрай failed.
    if (!isOrderPayable(order.status, order.paymentStatus)) {
      throw new PaykeeperError(
        'paykeeper_order_not_payable',
        `Заказ ${order.number} нельзя оплатить (статус заказа «${order.status}», оплаты «${order.paymentStatus}»).`,
      );
    }

    const clientId =
      order.customerEmail?.trim() || order.customerPhone?.trim() || order.customerName?.trim() || order.number;
    const cart = buildCart(order, items, cfg.defaultTax);

    // ---- MOCK-режим: без сети, фейковый invoice_id + внутренний URL. ----
    if (this.manager.isMock) {
      const res = this.manager.mock.mockCreateInvoice({
        orderId: order.number,
        payAmount,
        baseOrigin: opts.baseOrigin,
        returnUrl: opts.returnUrl,
      });
      await setPaymentRefAndProvider(order.id, res.invoiceId);
      return {
        invoiceId: res.invoiceId,
        paymentUrl: res.invoiceUrl,
        status: res.status,
        isMock: true,
      };
    }

    // ---- Боевой контур: реальный POST инвойса. ----
    const res = await this.manager.client.createInvoice({
      payAmount,
      clientId,
      orderId: order.number,
      cart,
      clientPhone: order.customerPhone?.trim() || undefined,
      clientEmail: order.customerEmail?.trim() || undefined,
    });
    await setPaymentRefAndProvider(order.id, res.invoiceId);
    return {
      invoiceId: res.invoiceId,
      paymentUrl: res.invoiceUrl,
      status: 'sent',
      isMock: false,
    };
  }

  /**
   * Обрабатывает колбэк PayKeeper с проверкой подписи и АТОМАРНОЙ идемпотентной
   * обработкой (docs/24 §2). secret — из config (PAYKEEPER_SECRET). Запись лога +
   * применение статуса + пометка processed — в ОДНОЙ транзакции (recordWebhookEvent).
   *
   * Возвращает { verified, processed, duplicate, paymentStatus, ack }. ack
   * (`OK `+md5(id+secret)) заполняется ТОЛЬКО на верифицированном событии (в т.ч.
   * заказ не найден / дубликат — как боевой carre). Невалидная подпись → ack:null.
   */
  async handleCallback(
    params: PaykeeperCallbackParams,
    ip?: string | null,
  ): Promise<HandleCallbackResult> {
    const cfg = this.manager.config;

    // 1) Проверка подписи — ГЛАВНАЯ защита. Без secret verify невозможен.
    if (!cfg.secret) {
      return { verified: false, processed: false, duplicate: false, paymentStatus: null, ack: null };
    }
    const verified = verifyCallbackSignature(params, cfg.secret);
    if (!verified) {
      return { verified: false, processed: false, duplicate: false, paymentStatus: null, ack: null };
    }

    const ack = buildCallbackAck(params.id, cfg.secret);

    if (!params.id) {
      // Подпись валидна, но нет invoice_id — обработать нечего (ack отдаём).
      return { verified: true, processed: false, duplicate: false, paymentStatus: null, ack };
    }

    // 2) Поиск заказа: приоритет payment_ref=id, фолбэк orders.number=orderid.
    let orderId: string | null = await findOrderIdByInvoiceId(params.id);
    if (!orderId && params.orderid) {
      const o = await getOrderByNumber(params.orderid);
      orderId = o?.order.id ?? null;
    }
    if (!orderId) {
      console.warn(
        `[paykeeper] callback: заказ не найден (id=${params.id}, orderid=${params.orderid}).`,
      );
      // Заказ не найден, но подпись валидна → отдаём OK (иначе PayKeeper ретраит).
      return { verified: true, processed: false, duplicate: false, paymentStatus: null, ack };
    }

    // 2b) СВЕРКА СУММЫ (anti-tamper, docs/24 §2 — закрывает low#1 шага 3b). Колбэк
    // несёт лишь факт «оплачено», но `sum` — недоверенное поле. Сверяем с СЕРВЕРНЫМ
    // grand_total (источник истины — БД). При расхождении НЕ метим paid молча:
    // записываем событие 'AMOUNT_MISMATCH' в лог (nextStatus=null → переход НЕ
    // применяется) для РУЧНОЙ сверки и логируем предупреждение. ack всё равно отдаём:
    // подпись валидна, ретраи PayKeeper сумму не изменят (иначе 50 бесполезных ретраев).
    const grandTotal = await getOrderGrandTotalById(orderId);
    const expectedKop = grandTotal !== null ? toKopecksSafe(grandTotal) : null;
    const paidKop = toKopecksSafe(params.sum);
    // expectedKop === null (grand_total недоступен) трактуем как «не могу проверить →
    // НЕ метить paid» (fail-safe), а не «не проверять». Иначе — расхождение суммы.
    if (expectedKop === null || paidKop !== expectedKop) {
      const mismatchReason = expectedKop === null ? 'grand_total_unavailable' : 'amount_mismatch';
      console.warn(
        `[paykeeper] callback SUM MISMATCH: invoice=${params.id} order=${orderId} ` +
          `paid=${paidKop} expected=${expectedKop ?? 'n/a'} reason=${mismatchReason} — ` +
          `НЕ метим paid, лог для ручной сверки.`,
      );
      await recordWebhookEvent({
        log: {
          orderId,
          invoiceId: params.id,
          status: 'AMOUNT_MISMATCH',
          amountKop: paidKop || null,
          isMock: this.manager.isMock,
          rawPayload: {
            source: 'callback',
            reason: mismatchReason,
            expectedKop,
            paidKop,
            ...sanitizeCallback(params),
            ip: ip ?? null,
          },
        },
        nextStatus: null, // переход НЕ применяется — заказ НЕ помечается paid
        comment: `paykeeper-callback:AMOUNT_MISMATCH reason=${mismatchReason} expected=${expectedKop ?? 'n/a'} paid=${paidKop}`,
      });
      return {
        verified: true,
        processed: false,
        duplicate: false,
        paymentStatus: null,
        amountMismatch: true,
        ack,
      };
    }

    // 3) Синтетический 'PAID': колбэк PayKeeper несёт лишь факт успешной оплаты.
    const next = mapPaykeeperStatus('PAID');

    // 4) АТОМАРНАЯ идемпотентная обработка (UNIQUE (invoice_id, status)).
    const result = await recordWebhookEvent({
      log: {
        orderId,
        invoiceId: params.id,
        status: 'PAID',
        amountKop: toKopecksSafe(params.sum) || null,
        isMock: this.manager.isMock,
        rawPayload: { source: 'callback', ...sanitizeCallback(params), ip: ip ?? null },
      },
      nextStatus: next,
      comment: 'paykeeper-callback:PAID',
    });
    // ПОСЛЕ КОММИТА: подарочные сертификаты по оплаченному заказу (ТЗ п.11).
    await autoIssueGiftsAfterCommit(orderId, result);
    const { inserted, processed } = result;
    if (!inserted) {
      // Дубликат: уже обработано — эффекты не повторяем, но OK отдаём.
      return { verified: true, processed: false, duplicate: true, paymentStatus: null, ack };
    }

    return { verified: true, processed, duplicate: false, paymentStatus: next, ack };
  }

  /**
   * DEMO-подтверждение mock-платежа (СТРОГО mock-режим, стенд без боевых ключей).
   * В mock secret отсутствует → колбэк не верифицируется; эта точка имитирует
   * успешную оплату, чтобы demo доходило до paid. В БОЕВОМ режиме — РЕФЬЮЗ.
   * Идемпотентно через recordWebhookEvent (UNIQUE (invoice_id, status)).
   */
  async confirmMockPayment(
    orderNumber: string,
    invoiceId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.manager.isMock) return { ok: false, reason: 'not_mock' };
    if (!orderNumber || !invoiceId) return { ok: false, reason: 'bad_request' };
    const found = await getOrderByNumber(orderNumber);
    if (!found) return { ok: false, reason: 'order_not_found' };
    // Привязка к инициированному счёту: invoiceId обязан совпадать с payment_ref,
    // записанным при initPayment. Иначе demo помечала бы оплаченным ЛЮБОЙ заказ по
    // номеру. payment_ref = mock-invoice_id (непредсказуем), его знает лишь инициатор.
    if (!found.order.paymentRef || invoiceId !== found.order.paymentRef) {
      return { ok: false, reason: 'payment_ref_mismatch' };
    }
    const result = await recordWebhookEvent({
      log: {
        orderId: found.order.id,
        invoiceId,
        status: 'PAID',
        amountKop: toKopecksSafe(found.order.grandTotal),
        isMock: true,
        rawPayload: { mock: true, source: 'mock-pay-demo', orderNumber, invoiceId },
      },
      nextStatus: mapPaykeeperStatus('PAID'),
      comment: 'mock-pay-demo:PAID',
    });
    await autoIssueGiftsAfterCommit(found.order.id, result);
    return { ok: true };
  }

  /**
   * СВЕРКА статуса через getInvoiceStatus (фолбэк потерянного колбэка). Дёргает
   * /info/invoice/byid/ (в mock — mockGetInvoiceStatus), маппит статус →
   * payment_status и АТОМАРНО+ИДЕМПОТЕНТНО доводит статус заказа через
   * recordWebhookEvent. amountKop — СЕРВЕРНЫЙ (из grand_total воркером).
   */
  async reconcilePayment(input: {
    orderId: string;
    orderNumber: string;
    invoiceId: string;
    amountKop?: number;
  }): Promise<ReconcilePaymentResult> {
    const isMock = this.manager.isMock;

    let statusRes: InvoiceStatusResult;
    if (isMock) {
      statusRes = this.manager.mock.mockGetInvoiceStatus(input.invoiceId);
    } else {
      try {
        statusRes = await this.manager.client.getInvoiceStatus(input.invoiceId);
      } catch (err) {
        return {
          ok: false,
          status: null,
          applied: false,
          isMock: false,
          reason: err instanceof PaykeeperError ? err.code : 'getstatus_failed',
        };
      }
    }

    const status = statusRes.status;
    const next = mapPaykeeperStatus(status);
    const result = await recordWebhookEvent({
      log: {
        orderId: input.orderId,
        invoiceId: input.invoiceId,
        status: status ?? 'UNKNOWN',
        amountKop: input.amountKop ?? null,
        isMock,
        rawPayload: { source: 'reconcile-status', orderNumber: input.orderNumber },
      },
      nextStatus: next,
      comment: `reconcile-status:${status}`,
    });
    await autoIssueGiftsAfterCommit(input.orderId, result);
    return { ok: true, status, applied: result.processed, isMock };
  }

  /**
   * ШЛЮЗОВОЙ ВОЗВРАТ (MVP). PayKeeper reverse через API в MVP НЕ реализуем
   * (docs/24 §2, риски) → всегда skipped:'manual' (оператор возвращает вручную в
   * ЛК PayKeeper). Внутренний сетл payment_status='refunded' делает вызывающий
   * экшен. Полноценный gateway-reverse — Фаза 2.
   */
  async refundPayment(_input: {
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    paymentProvider: string | null;
    paymentRef: string | null;
    amountKop: number;
  }): Promise<RefundPaymentResult> {
    void _input;
    return { ok: true, skipped: true, status: null, isMock: this.manager.isMock, reason: 'manual' };
  }
}

/**
 * Собирает cart для service_name счёта из позиций заказа (docs/24 §2, сверено с
 * carre). Суммы — В РУБЛЯХ (десятичные строки). tax — defaultTax из конфигурации.
 * Пустые позиции → одна строка на весь заказ (PayKeeper требует непустой cart).
 */
function buildCart(order: Order, items: OrderItem[], tax: string): PaykeeperCartItem[] {
  if (items.length === 0) {
    return [
      {
        name: `Заказ ${order.number}`,
        price: normalizeMoney(order.grandTotal),
        quantity: 1,
        sum: normalizeMoney(order.grandTotal),
        tax,
      },
    ];
  }
  return items.map((it) => ({
    name: it.nameSnapshot,
    price: normalizeMoney(it.unitPrice),
    quantity: it.quantity,
    sum: normalizeMoney(it.lineTotal),
    tax,
  }));
}
