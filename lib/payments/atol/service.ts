/**
 * Сервис АТОЛ Pay Ecom: регистрация платежа, обработка callback, сверка, возврат.
 *
 * 🔴 ГЛАВНЫЙ АРХИТЕКТУРНЫЙ ПРИНЦИП, ОТЛИЧАЮЩИЙ ЭТОТ ПРОВАЙДЕР ОТ ОСТАЛЬНЫХ.
 *
 * У callback АТОЛа НЕТ ПОДПИСИ — ни HMAC, ни секрета уведомлений, ни
 * контрольной суммы (в отличие от Т-Банка и Озона). Тело запроса НЕ доказывает
 * отправителя. Поэтому здесь действует правило:
 *
 *     CALLBACK — ЭТО ТОЛЬКО СИГНАЛ «СХОДИ ПРОВЕРЬ».
 *     Статус заказа меняется ИСКЛЮЧИТЕЛЬНО по ответу
 *     GET /payments/{orderId}/status, запрошенному нами по токену.
 *
 * Секрет в query-параметре (callback.ts) отсеивает случайный шум, но он
 * попадает в логи прокси и не может быть единственной защитой. Сверка через
 * API не зависит от секрета и работает даже при его утечке.
 *
 * Второе следствие: `status` в теле («success») — это статус ОБРАБОТКИ
 * ЗАПРОСА, а не факт оплаты. Оплату определяет только числовой paymentStatus,
 * подтверждённый сверкой.
 */

import { logger } from '@/lib/logger';
import type { Order, OrderItem, PaymentStatus } from '@/lib/orders/types';

import { getAtolConfig, type AtolConfig } from './config';
import { atolRequest } from './client';
import { AtolError } from './errors';
import { buildNotificationUrl, isFailedFiscalization } from './callback';
import { buildPositions, rublesToKopecks } from './money';
import { mapPaymentStatus, describeAtolStatus } from './status-map';
import {
  recordCallback,
  setPaymentRefAndProvider,
  findOrderIdByPaymentRef,
} from './repository';
import type {
  AtolCallback,
  AtolCreatePaymentRequest,
  AtolCreatePaymentResponse,
  AtolPaymentStatusResponse,
  AtolPaymentMethod,
  InitPaymentResult,
} from './types';

const log = logger.child({ module: 'payments/atol' });

/** Фискализация на стороне АТОЛ Онлайн — отдельная касса не нужна. */
const RECEIPT_PROVIDER_ATOL_ONLINE = 100;

/** Результат обработки callback. */
export interface HandleCallbackResult {
  /** Событие отнесено к известному заказу и записано. */
  accepted: boolean;
  /** Записано впервые (false → повторная доставка). */
  inserted: boolean;
  /** Переход payment_status применён. */
  processed: boolean;
  /** Причина штатного отказа — для журнала и ответа роуту. */
  reason?: string;
}

export class AtolPaymentService {
  private readonly cfg: AtolConfig;

  constructor(source?: Record<string, string | undefined>) {
    this.cfg = getAtolConfig(source);
  }

  /** Боевой токен не задан — оплата эмулируется, в сеть не ходим. */
  get isMock(): boolean {
    return this.cfg.token === null;
  }

  /** Способы оплаты. Пусто → банк берётся из настроек ЛК АТОЛа. */
  private buildPaymentMethods(): AtolPaymentMethod[] | undefined {
    const methods: AtolPaymentMethod[] = [];
    if (this.cfg.cardBankId !== null) {
      methods.push({ paymentType: 'card', bankId: this.cfg.cardBankId });
    }
    if (this.cfg.sbpBankId !== null) {
      methods.push({ paymentType: 'sbp', bankId: this.cfg.sbpBankId });
    }
    return methods.length > 0 ? methods : undefined;
  }

  /**
   * Регистрирует платёж и возвращает ссылку на оплату.
   *
   * Идемпотентность: orderId = номер заказа. Повторная регистрация того же
   * заказа отбивается кодом PAYMENT_EXISTS — это не сбой, а возврат покупателя
   * к неоплаченному заказу, поэтому обрабатывается отдельно.
   */
  async initPayment(
    order: Order,
    items: OrderItem[],
    opts: { baseOrigin?: string; returnUrl?: string } = {},
  ): Promise<InitPaymentResult> {
    // ANTI-TAMPER: сумма считается из заказа, из запроса покупателя — никогда.
    const amountKop = rublesToKopecks(order.grandTotal);
    if (amountKop <= 0) {
      throw new AtolError('Сумма заказа должна быть положительной.');
    }

    if (this.isMock) {
      // MOCK: в сеть не ходим. Реальных денег здесь нет.
      const origin = opts.baseOrigin ?? '';
      const url =
        opts.returnUrl ??
        `${origin}/order-success.html?order=${encodeURIComponent(order.number)}`;
      log.warn('atol: MOCK-режим — оплата ненастоящая, токен не задан', {
        orderNumber: order.number,
      });
      return { paymentUrl: url, paymentId: `mock-${order.id}`, status: null, isMock: true };
    }

    // 🔴 Без СНО и ставки НДС чек составить нельзя, а платёж без чека для
    // интернет-магазина — нарушение 54-ФЗ. Падаем явно, а не отправляем
    // платёж «пока без фискализации»: молчаливый обход закона хуже отказа.
    if (this.cfg.sno === null || this.cfg.defaultTax === null) {
      throw new AtolError(
        'Не заданы фискальные реквизиты магазина (ATOL_PAY_SNO / ATOL_PAY_DEFAULT_TAX) — ' +
          'чек составить нельзя.',
      );
    }

    const positions = buildPositions(order, items, {
      sno: this.cfg.sno,
      tax: this.cfg.defaultTax,
      productSubject: this.cfg.productSubject,
      deliverySubject: this.cfg.deliverySubject,
      paymentMethod: this.cfg.paymentMethodSubject,
    });

    // 🔴 Несходящийся чек АТОЛ отвергнет кодом INVALID_RECEIPT_AMOUNT. Лучше
    // остановиться здесь с внятной диагностикой, чем получить отказ шлюза.
    if (positions === null) {
      throw new AtolError(
        `Состав чека не сошёлся с суммой заказа ${order.number} — платёж не отправлен.`,
      );
    }

    const notificationUrl = this.cfg.notificationUrl
      ? buildNotificationUrl(this.cfg.notificationUrl, this.cfg.notificationSecret ?? '')
      : undefined;

    const body: AtolCreatePaymentRequest = {
      amount: amountKop,
      orderId: order.number,
      sessionType: this.cfg.sessionType,
      additionalProps: {
        returnUrl: opts.returnUrl ?? this.cfg.returnUrl ?? undefined,
        notificationUrl,
      },
      receipt: {
        providerId: RECEIPT_PROVIDER_ATOL_ONLINE,
        sno: this.cfg.sno,
        positions,
      },
      paymentMethods: this.buildPaymentMethods(),
    };

    let res: AtolCreatePaymentResponse;
    try {
      res = await atolRequest<AtolCreatePaymentResponse>(
        this.cfg.baseUrl,
        this.cfg.token!,
        'POST',
        'payments',
        body,
      );
    } catch (err) {
      if (err instanceof AtolError && err.isReceiptAmountMismatch) {
        // Диагностика в НАШУ сторону: расхождение посчитано у нас (money.ts).
        log.error('atol: сумма платежа не сошлась с суммой позиций чека', {
          orderNumber: order.number,
          amountKop,
        });
      }
      throw err;
    }

    if (!res.paymentUrl) {
      throw new AtolError('АТОЛ Pay не вернул ссылку на оплату.');
    }

    await setPaymentRefAndProvider(order.id, res.orderId ?? order.number);

    return {
      paymentUrl: res.paymentUrl,
      paymentId: res.orderId ?? order.number,
      status: null,
      isMock: false,
    };
  }

  /**
   * Запрашивает статус платежа у АТОЛа. Это единственный достоверный источник
   * факта оплаты: callback не подписан и сам по себе ничего не доказывает.
   */
  async fetchStatus(atolOrderId: string): Promise<AtolPaymentStatusResponse> {
    return await atolRequest<AtolPaymentStatusResponse>(
      this.cfg.baseUrl,
      this.cfg.token!,
      'GET',
      `payments/${encodeURIComponent(atolOrderId)}/status`,
    );
  }

  /**
   * Обрабатывает входящее событие callback.
   *
   * 🔴 Порядок намеренный: сначала ищем заказ, затем СВЕРЯЕМ статус через API,
   * и только потом пишем в журнал вместе с проверенным переходом. Тело
   * callback используется лишь для того, чтобы понять, ПРО ЧТО событие, —
   * но не для того, чтобы решить, чем оно закончилось.
   */
  async handleCallback(
    cb: AtolCallback,
    ctx: { ip?: string | null; expectedAmountKop?: number },
  ): Promise<HandleCallbackResult> {
    const orderId = await findOrderIdByPaymentRef(cb.orderId);
    if (!orderId) {
      // Штатный исход, не исключение: событие по неизвестному нам заказу.
      log.warn('atol: callback по неизвестному заказу', { atolOrderId: cb.orderId, type: cb.type });
      return { accepted: false, inserted: false, processed: false, reason: 'order_not_found' };
    }

    const receiptFailed = isFailedFiscalization(cb);
    if (receiptFailed) {
      // 🔴 Деньги списаны, чек не пробит: «транзакция не отменяется, если чек
      // отправился неуспешно». Нарушение 54-ФЗ, чинится только чеком коррекции.
      log.error(
        'atol: 🔴 ЧЕК НЕ ПРОБИТ, А ДЕНЬГИ СПИСАНЫ — требуется чек коррекции (54-ФЗ)',
        {
          atolOrderId: cb.orderId,
          receiptId: cb.receiptId ?? null,
          errorMessage: cb.errorMessage ?? null,
        },
      );
    }

    // Сверка. Событие фискализации к статусу ОПЛАТЫ отношения не имеет —
    // для него сверка не нужна и статус не меняется.
    let nextStatus: PaymentStatus | null = null;
    let verifiedStatus: number | null = null;
    let verifiedAmount: number | null = null;

    if (cb.type !== 'fiscal' && !this.isMock) {
      try {
        const status = await this.fetchStatus(cb.orderId);
        verifiedStatus = typeof status.paymentStatus === 'number' ? status.paymentStatus : null;
        verifiedAmount = typeof status.amount === 'number' ? status.amount : null;
        nextStatus = mapPaymentStatus(verifiedStatus);

        // 🔴 Сверка суммы: совпадения статуса мало. Если подтверждённая сумма
        // меньше ожидаемой, помечать заказ оплаченным нельзя.
        const expected = ctx.expectedAmountKop;
        if (
          nextStatus === 'paid' &&
          typeof expected === 'number' &&
          verifiedAmount !== null &&
          verifiedAmount < expected
        ) {
          log.error('atol: подтверждённая сумма меньше суммы заказа — оплата не засчитана', {
            atolOrderId: cb.orderId,
            verifiedAmount,
            expected,
          });
          nextStatus = null;
        }
      } catch (err) {
        // Сверка не удалась — статус НЕ меняем. Событие всё равно пишем в
        // журнал: потерять его нельзя, а крон-сверка вернётся к заказу позже.
        log.warn('atol: сверка статуса не удалась — статус заказа не меняем', {
          atolOrderId: cb.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
        nextStatus = null;
      }
    }

    const comment = `АТОЛ: ${cb.type}${
      verifiedStatus !== null ? ` — ${describeAtolStatus(verifiedStatus)} (сверено)` : ''
    }`;

    const res = await recordCallback({
      log: {
        orderId,
        atolOrderId: cb.orderId,
        type: cb.type,
        // В журнал кладём ПОДТВЕРЖДЁННЫЙ статус, если сверка прошла, иначе —
        // присланный, помечая его как неподтверждённый через processed.
        paymentStatus: verifiedStatus ?? cb.paymentStatus ?? null,
        requestStatus: cb.status || null,
        amountKop: verifiedAmount ?? cb.amount ?? null,
        receiptId: cb.receiptId ?? null,
        receiptType: cb.receiptType ?? null,
        receiptFailed,
        errorCode: cb.errorCode ?? null,
        errorMessage: cb.errorMessage ?? null,
        isMock: this.isMock,
        rawPayload: cb as unknown as Record<string, unknown>,
        ip: ctx.ip ?? null,
      },
      nextStatus,
      comment,
    });

    return { accepted: true, inserted: res.inserted, processed: res.processed, reason: undefined };
  }

  /**
   * Сверяет статус платежа с эквайером (фоллбэк, если callback не дошёл).
   * У АТОЛа это не запасной путь, а основной механизм подтверждения.
   */
  async reconcile(order: Order): Promise<{ status: string | null; applied: boolean }> {
    if (this.isMock) return { status: null, applied: false };

    const ref = order.paymentRef;
    if (!ref) return { status: null, applied: false };

    const status = await this.fetchStatus(ref);
    const code = typeof status.paymentStatus === 'number' ? status.paymentStatus : null;
    const next = mapPaymentStatus(code);
    if (!next) return { status: code === null ? null : String(code), applied: false };

    // 🔴 СВЕРКА СУММЫ, как и в handleCallback. У платформы два пути к `paid`
    // (callback и эта сверка), и проверка обязана стоять на ОБОИХ: иначе
    // достаточно пройти по тому, где её нет. Касается только перехода в
    // `paid` — у возврата и отказа сумма события законно иная. Переплата
    // не препятствие: покупатель заплатил не меньше должного.
    if (next === 'paid') {
      const verifiedAmount = typeof status.amount === 'number' ? status.amount : null;
      const expectedKop = rublesToKopecks(order.grandTotal);
      if (verifiedAmount !== null && verifiedAmount < expectedKop) {
        log.error('atol: сверка — подтверждённая сумма меньше суммы заказа, оплата не засчитана', {
          orderNumber: order.number,
          verifiedAmount,
          expectedKop,
        });
        return { status: String(code), applied: false };
      }
    }

    const { applyPaymentStatus } = await import('./repository');
    const applied = await applyPaymentStatus(
      order.id,
      next,
      `АТОЛ: сверка — ${describeAtolStatus(code)}`,
    );
    return { status: code === null ? null : String(code), applied };
  }

  /**
   * Возврат денег. У АТОЛа отмена и возврат — ОДНА ручка, в том числе
   * частичный возврат (передаётся сумма).
   *
   * ⚠️ Для одностадийной оплаты возврат доступен через сутки после оплаты —
   * до этого шлюз ответит отказом, и это не наша ошибка.
   */
  async refund(input: { paymentRef: string; amountKop: number }): Promise<void> {
    if (this.isMock) return;

    await atolRequest(
      this.cfg.baseUrl,
      this.cfg.token!,
      'POST',
      `payments/${encodeURIComponent(input.paymentRef)}/cancel`,
      { amount: input.amountKop },
    );
  }
}
