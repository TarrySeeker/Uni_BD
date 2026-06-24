/**
 * PaymentService — инициация оплаты и приём webhook Т-Банка (docs/15 §4, порт
 * lib/cdek/services/webhook.ts + order.ts).
 *
 * initPayment(order) — собирает Init (TerminalKey/OrderId/Amount/PayType + опц.
 *   Receipt), в mock-режиме возвращает фейковый PaymentId+PaymentURL, в боевом —
 *   бьёт в /v2/Init. Суммы — КОПЕЙКИ, считаются СЕРВЕРОМ из orders.grand_total
 *   (anti-tamper, ADR-010), не из запроса витрины. Сохраняет PaymentId на заказе.
 *
 * handleWebhook(payload) — КЛЮЧЕВОЕ (docs/15 §4.2, §7):
 *   1) проверка Token (verifyNotificationToken); невалид → verified:false (403);
 *   2) parseNotification → нормализация + поиск заказа;
 *   3) маппинг Status → payment_status (status-map);
 *   4) АТОМАРНАЯ обработка recordWebhookEvent (одна транзакция): идемпотентная
 *      запись в tbank_payment_log (UNIQUE (payment_id, status), ON CONFLICT DO
 *      NOTHING) + переход canTransition + пометка processed. Дубликат →
 *      duplicate:true без повторных эффектов. Сбой БД откатывает ВСЁ (вставку
 *      лога тоже) → повтор события переприменит статус (закрыт баг неатомарности).
 *
 * Чистая parseNotification (без сети/БД) тестируется отдельно; БД-зависимый
 * handleWebhook — интеграционно (skipIf) либо с моком репозитория в юнит-тесте.
 */

import type { Order, OrderItem } from '@/lib/orders/types';
import { getOrderByNumber } from '@/lib/orders/repository';
import { TbankManager, getTbankManager } from './manager';
import { TbankError } from './errors';
import { mapTbankStatus } from './status-map';
import { isOrderPayable } from '@/lib/orders/status';
import { verifyNotificationToken } from './token';
import { buildReceipt } from './receipt';
import { toKopecks } from './receipt';
import { recordWebhookEvent, setPaymentRefAndProvider } from './repository';
import type {
  HandleWebhookResult,
  InitPaymentResult,
  TbankEvent,
  TbankInitRequest,
  TbankInitResponse,
  TbankNotification,
} from './types';

// =============================================================================
// parseNotification — ЧИСТАЯ. Нормализация тела webhook → TbankEvent. docs/15 §4.2.
// =============================================================================

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number') return String(v);
  return null;
}
function int(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Нормализует тело уведомления Т-Банка в TbankEvent (чистая). Толерантна к форме:
 * читает OrderId/PaymentId/Status/Amount/Token. Невалидный объект → событие с
 * null-полями (вызывающий отфильтрует по отсутствию paymentId/status).
 */
export function parseNotification(payload: unknown): TbankEvent {
  const p = (payload && typeof payload === 'object' ? payload : {}) as TbankNotification;
  return {
    orderNumber: str(p.OrderId),
    paymentId: str(p.PaymentId),
    status: str(p.Status),
    amountKop: int(p.Amount),
    token: typeof p.Token === 'string' ? p.Token : null,
    raw: p as Record<string, unknown>,
  };
}

/**
 * Маскирует чувствительные поля webhook перед записью в лог (docs/15 §7): убирает
 * Token и PAN/CardId. Возвращает копию без секретов (аудит/replay безопасны).
 */
export function sanitizeNotification(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const { Token: _t, Pan: _p, CardId: _c, ...rest } = raw as Record<string, unknown>;
  void _t;
  void _p;
  void _c;
  return rest;
}

// =============================================================================
// PaymentService — Init + webhook.
// =============================================================================

export class PaymentService {
  constructor(private readonly manager: TbankManager = getTbankManager()) {}

  /**
   * Инициирует платёж по заказу (docs/15 §4.1). Amount — КОПЕЙКИ из grand_total
   * (сервер, anti-tamper). В mock — фейковый PaymentId/PaymentURL; в боевом —
   * POST /v2/Init с подписью Token (клиент подписывает сам). Сохраняет PaymentId
   * + payment_provider='tbank' на заказе. baseOrigin (опц.) абсолютизирует mock-URL.
   */
  async initPayment(
    order: Order,
    items: OrderItem[] = [],
    opts: { baseOrigin?: string; returnUrl?: string } = {},
  ): Promise<InitPaymentResult> {
    const cfg = this.manager.config;
    const amountKop = toKopecks(order.grandTotal);
    if (amountKop <= 0) {
      throw new TbankError('tbank_invalid_amount', `Некорректная сумма заказа: ${order.grandTotal}.`);
    }
    // Гард оплачиваемости (backend-инвариант): отменённый/возвращённый заказ и уже
    // оплаченный/возвращённый платёж оплачивать нельзя. Раньше init проверял только
    // сумму → отменённый заказ (order.status='cancelled', payment_status='pending')
    // можно было оплатить. Допускает ретрай failed-оплаты.
    if (!isOrderPayable(order.status, order.paymentStatus)) {
      throw new TbankError(
        'tbank_order_not_payable',
        `Заказ ${order.number} нельзя оплатить (статус заказа «${order.status}», оплаты «${order.paymentStatus}»).`,
      );
    }

    // ---- MOCK-режим: без сети, фейковый PaymentId + внутренний PaymentURL. ----
    if (this.manager.isMock) {
      const res = this.manager.mock.mockInitPayment({
        orderId: order.number,
        amountKop,
        baseOrigin: opts.baseOrigin,
        returnUrl: opts.returnUrl,
      });
      await setPaymentRefAndProvider(order.id, res.paymentId);
      return {
        paymentId: res.paymentId,
        paymentUrl: res.paymentUrl,
        status: res.status,
        isMock: true,
      };
    }

    // ---- Боевой/тестовый контур: реальный Init. ----
    const body: TbankInitRequest = {
      TerminalKey: cfg.terminalKey!,
      Amount: amountKop,
      OrderId: order.number,
      Description: `Заказ ${order.number}`,
      PayType: cfg.payType,
      ...(cfg.notificationUrl ? { NotificationURL: cfg.notificationUrl } : {}),
      ...(cfg.successUrl ? { SuccessURL: cfg.successUrl } : {}),
      ...(cfg.failUrl ? { FailURL: cfg.failUrl } : {}),
      RedirectDueDate: redirectDueDate(cfg.redirectDueMin),
    };

    // Чек 54-ФЗ — опционально (по умолчанию выключен). Вложенный объект в подпись
    // Token НЕ идёт (token.ts исключает не-скаляры).
    if (cfg.receiptEnabled) {
      const receipt = buildReceipt(order, items, cfg);
      if (receipt) body.Receipt = receipt;
    }

    const res = await this.manager.client.call<TbankInitResponse>('Init', body);
    if (!res.Success || !res.PaymentId || !res.PaymentURL) {
      throw new TbankError(
        'tbank_init_failed',
        `Init не удался: ${res.Message ?? res.ErrorCode ?? 'unknown'}`,
        { tbankErrorCode: res.ErrorCode ?? null },
      );
    }
    await setPaymentRefAndProvider(order.id, res.PaymentId);
    return {
      paymentId: res.PaymentId,
      paymentUrl: res.PaymentURL,
      status: res.Status ?? 'NEW',
      isMock: false,
    };
  }

  /**
   * Обрабатывает webhook Т-Банка с проверкой Token и АТОМАРНОЙ идемпотентной
   * обработкой (docs/15 §4.2). Token берётся из config.password (секрет). Запись
   * лога + применение статуса + пометка processed выполняются в ОДНОЙ транзакции
   * (recordWebhookEvent) — сбой БД откатывает всё и оставляет событие повторяемым
   * (закрыт critical-баг неатомарности). Возвращает
   * { verified, processed, duplicate, paymentStatus }.
   */
  async handleWebhook(payload: unknown): Promise<HandleWebhookResult> {
    const cfg = this.manager.config;
    const event = parseNotification(payload);

    // 1) Проверка Token. В боевом режиме password всегда задан; в mock —
    //    подписываем тем же mock-password (см. service-уровень demo), но если
    //    password отсутствует — verify невозможен → не верифицируем.
    if (!cfg.password) {
      return { verified: false, processed: false, duplicate: false, paymentStatus: null };
    }
    const verified = verifyNotificationToken(event.raw, cfg.password);
    if (!verified) {
      return { verified: false, processed: false, duplicate: false, paymentStatus: null };
    }

    if (!event.paymentId || !event.status) {
      return { verified: true, processed: false, duplicate: false, paymentStatus: null };
    }

    // 2) Поиск заказа по номеру (OrderId).
    let orderId: string | null = null;
    if (event.orderNumber) {
      const o = await getOrderByNumber(event.orderNumber);
      orderId = o?.order.id ?? null;
    }
    if (!orderId) {
      console.warn(
        `[tbank] webhook: заказ не найден (OrderId=${event.orderNumber}, PaymentId=${event.paymentId}).`,
      );
      return { verified: true, processed: false, duplicate: false, paymentStatus: null };
    }

    // 3) АТОМАРНАЯ обработка события в ОДНОЙ транзакции: запись лога (raw без
    //    Token/PAN) + применение перехода payment_status + пометка processed.
    //    recordWebhookEvent гарантирует, что при сбое БД посреди обработки
    //    откатывается ВСЁ (включая вставку лога) — поэтому повтор события снова
    //    применит статус (закрыт critical-баг неатомарности, потери денег).
    //    Недопустимый/отсутствующий маппинг (next=null) → processed=false (no-op),
    //    дубликат (inserted=false) → ранний выход без эффектов.
    const next = mapTbankStatus(event.status);
    const { inserted, processed } = await recordWebhookEvent({
      log: {
        orderId,
        paymentId: event.paymentId,
        status: event.status,
        amountKop: event.amountKop,
        isMock: this.manager.isMock,
        rawPayload: sanitizeNotification(event.raw),
      },
      nextStatus: next,
      comment: `tbank-webhook:${event.status}`,
    });
    if (!inserted) {
      // Дубликат: уже обработано — НЕ повторяем эффекты.
      return { verified: true, processed: false, duplicate: true, paymentStatus: null };
    }

    return { verified: true, processed, duplicate: false, paymentStatus: next };
  }

  /**
   * DEMO-подтверждение mock-платежа (СТРОГО mock-режим, для стенда без боевых
   * ключей Т-Банк). В mock пароль отсутствует → webhook не верифицируется и платёж
   * нельзя довести до paid штатно; эта точка имитирует CONFIRMED, чтобы demo-оплата
   * доходила до конца. В БОЕВОМ режиме (заданы TBANK_*) — РЕФЬЮЗ (никакого обхода
   * реальной оплаты). Идемпотентно через recordWebhookEvent (UNIQUE payment_id,status).
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
    // записанным при initPayment. Иначе demo-страница помечала бы оплаченным ЛЮБОЙ
    // заказ по номеру (без аутентификации) — достаточно угадать номер. payment_ref
    // = mock-PaymentId (непредсказуемый), его знает только инициировавший оплату.
    if (!found.order.paymentRef || paymentId !== found.order.paymentRef) {
      return { ok: false, reason: 'payment_ref_mismatch' };
    }
    await recordWebhookEvent({
      log: {
        orderId: found.order.id,
        paymentId,
        status: 'CONFIRMED',
        amountKop: toKopecks(found.order.grandTotal),
        isMock: true,
        rawPayload: { mock: true, source: 'mock-pay-demo', orderNumber, paymentId },
      },
      nextStatus: mapTbankStatus('CONFIRMED'),
      comment: 'mock-pay-demo:CONFIRMED',
    });
    return { ok: true };
  }
}

/**
 * RedirectDueDate в формате Т-Банка (docs/15 §4.1): 'YYYY-MM-DDTHH:MM:SS+03:00'
 * через N минут от текущего момента.
 *
 * Т-API /v2/Init требует ИМЕННО этот вид — БЕЗ миллисекунд и БЕЗ суффикса 'Z'
 * (toISOString() даёт '...SS.mmmZ' → Init отклоняется по валидации формата даты).
 *
 * Смещение МСК фиксированное +03:00: РФ не переходит на летнее время с 2014 г.,
 * Москва постоянно UTC+3. Берём UTC-инстант, сдвигаем на +3ч и читаем компоненты
 * через getUTC* (не зависит от TZ сервера — он может быть в UTC), затем явно
 * приписываем '+03:00'. Отдельной TZ-конфигурации в проекте нет (см. config.ts).
 *
 * baseMs (опц.) — для детерминированных тестов; по умолчанию Date.now().
 */
const MSK_OFFSET_MIN = 180; // +03:00, фиксированное (без перехода на лето)

export function redirectDueDate(minutes: number, baseMs: number = Date.now()): string {
  // Сдвигаем UTC-инстант на МСК-смещение, чтобы getUTC* отдали стенные часы МСК.
  const msk = new Date(baseMs + minutes * 60_000 + MSK_OFFSET_MIN * 60_000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const date = `${p(msk.getUTCFullYear(), 4)}-${p(msk.getUTCMonth() + 1)}-${p(msk.getUTCDate())}`;
  const time = `${p(msk.getUTCHours())}:${p(msk.getUTCMinutes())}:${p(msk.getUTCSeconds())}`;
  return `${date}T${time}+03:00`;
}
