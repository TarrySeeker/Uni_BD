/**
 * Сервис АТОЛ Pay: инициация оплаты и обработка callback.
 *
 * 🔴 ГЛАВНОЕ ПРОВЕРЯЕМОЕ СВОЙСТВО. У callback АТОЛа нет подписи, поэтому тело
 * запроса НЕ является основанием менять статус заказа. Сервис обязан сходить
 * в API за статусом и принять решение ТОЛЬКО по ответу, полученному по токену.
 * Тест на это — «не верит телу callback» — важнее всех остальных в файле.
 *
 * БД и сеть замоканы: живой БД в тестах кита нет.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Order, OrderItem } from '@/lib/orders/types';

// ── Моки репозитория (БД) ───────────────────────────────────────────────────
const recordCallbackMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ inserted: true, processed: true }),
);
const setPaymentRefMock = vi.fn((..._a: unknown[]) => Promise.resolve());
const findOrderIdByPaymentRefMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve<string | null>('order-uuid-1'),
);
const applyPaymentStatusMock = vi.fn((..._a: unknown[]) => Promise.resolve(true));

vi.mock('@/lib/payments/atol/repository', () => ({
  recordCallback: (...a: unknown[]) => recordCallbackMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefMock(...a),
  findOrderIdByPaymentRef: (...a: unknown[]) => findOrderIdByPaymentRefMock(...a),
  applyPaymentStatus: (...a: unknown[]) => applyPaymentStatusMock(...a),
}));

// ── Мок HTTP-клиента ────────────────────────────────────────────────────────
const atolRequestMock = vi.fn((..._a: unknown[]) => Promise.resolve<unknown>({}));
vi.mock('@/lib/payments/atol/client', () => ({
  atolRequest: (...a: unknown[]) => atolRequestMock(...a),
}));

const { AtolPaymentService } = await import('@/lib/payments/atol/service');

/** Боевое окружение: токен есть, реквизиты чека заданы. */
const LIVE = {
  ATOL_PAY_TOKEN: 'live-token',
  ATOL_PAY_NOTIFICATION_SECRET: 's'.repeat(32),
  ATOL_PAY_SNO: '1',
  ATOL_PAY_DEFAULT_TAX: '5',
  ATOL_PAY_NOTIFICATION_URL: 'https://admin.example.ru/api/payments/atol/webhook',
} as const;

function order(over: Partial<Order> = {}): Order {
  return {
    id: 'order-uuid-1',
    number: 'NM-1001',
    itemsTotal: '1000.00',
    discountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '1000.00',
    paymentRef: null,
    ...over,
  } as Order;
}

function items(): OrderItem[] {
  return [
    {
      id: 'i-1',
      nameSnapshot: 'Аметист друза',
      unitPrice: '1000.00',
      quantity: 1,
      lineTotal: '1000.00',
    } as OrderItem,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  atolRequestMock.mockResolvedValue({});
  findOrderIdByPaymentRefMock.mockResolvedValue('order-uuid-1');
  recordCallbackMock.mockResolvedValue({ inserted: true, processed: true });
});

describe('atol/service — mock-режим', () => {
  it('без токена в сеть не ходит и помечает результат как ненастоящий', async () => {
    const svc = new AtolPaymentService({});
    expect(svc.isMock).toBe(true);

    const res = await svc.initPayment(order(), items(), { baseOrigin: 'https://shop.test' });
    expect(res.isMock).toBe(true);
    expect(atolRequestMock).not.toHaveBeenCalled();
  });
});

describe('atol/service — инициация оплаты', () => {
  it('регистрирует платёж и сохраняет payment_ref', async () => {
    atolRequestMock.mockResolvedValue({
      orderId: 'NM-1001',
      amount: 100000,
      paymentUrl: 'https://pay.atol.test/abc',
    });

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.initPayment(order(), items(), { baseOrigin: 'https://shop.test' });

    expect(res.paymentUrl).toBe('https://pay.atol.test/abc');
    expect(res.isMock).toBe(false);
    expect(setPaymentRefMock).toHaveBeenCalled();
  });

  /** 🔴 Сумма берётся из заказа, а не из запроса покупателя. */
  it('🔴 сумма платежа — из grandTotal заказа, в копейках', async () => {
    atolRequestMock.mockResolvedValue({ orderId: 'x', paymentUrl: 'u', amount: 0 });
    const svc = new AtolPaymentService({ ...LIVE });
    // Состав заказа согласован с итогом: иначе чек (справедливо) не отправится.
    await svc.initPayment(
      order({ itemsTotal: '1234.56', grandTotal: '1234.56' }),
      [{ ...items()[0], unitPrice: '1234.56', lineTotal: '1234.56' }],
      {},
    );

    const body = atolRequestMock.mock.calls[0]?.[4] as { amount: number };
    expect(body.amount).toBe(123456);
  });

  it('🔴 секрет уходит в notificationUrl query-параметром', async () => {
    atolRequestMock.mockResolvedValue({ orderId: 'x', paymentUrl: 'u', amount: 0 });
    const svc = new AtolPaymentService({ ...LIVE });
    await svc.initPayment(order(), items(), {});

    const body = atolRequestMock.mock.calls[0]?.[4] as {
      additionalProps?: { notificationUrl?: string };
    };
    const url = new URL(body.additionalProps!.notificationUrl!);
    expect(url.searchParams.get('secret')).toBe('s'.repeat(32));
  });

  it('чек содержит СНО магазина и позиции с нужной ставкой', async () => {
    atolRequestMock.mockResolvedValue({ orderId: 'x', paymentUrl: 'u', amount: 0 });
    const svc = new AtolPaymentService({ ...LIVE });
    await svc.initPayment(order(), items(), {});

    const body = atolRequestMock.mock.calls[0]?.[4] as {
      receipt?: { sno: number; providerId: number; positions: { tax: number }[] };
    };
    expect(body.receipt!.sno).toBe(1);
    // 100 = АТОЛ Онлайн: чеки пробивает АТОЛ, отдельная касса не нужна.
    expect(body.receipt!.providerId).toBe(100);
    expect(body.receipt!.positions[0].tax).toBe(5);
  });

  /**
   * 🔴 Без СНО и ставки НДС чек составить нельзя: неверные реквизиты — это
   * нарушение 54-ФЗ. Молча отправить платёж без чека тоже нельзя.
   */
  it('🔴 без sno/tax платёж не регистрируется', async () => {
    const svc = new AtolPaymentService({ ATOL_PAY_TOKEN: 'live-token' });
    await expect(svc.initPayment(order(), items(), {})).rejects.toThrow();
    expect(atolRequestMock).not.toHaveBeenCalled();
  });

  it('нулевая сумма заказа отвергается', async () => {
    const svc = new AtolPaymentService({ ...LIVE });
    await expect(svc.initPayment(order({ grandTotal: '0.00' }), items(), {})).rejects.toThrow();
  });
});

describe('atol/service — 🔴 обработка callback: доверяем только сверке', () => {
  const paidCallback = {
    status: 'success' as const,
    orderId: 'NM-1001',
    type: 'payment' as const,
    paymentStatus: 1,
    amount: 100000,
  };

  /**
   * 🔴 ЦЕНТРАЛЬНЫЙ ТЕСТ ВСЕЙ ИНТЕГРАЦИИ.
   * Подписи у callback нет. Если сервис поверит телу, злоумышленник, узнавший
   * URL и секрет из логов, пометит неоплаченный заказ оплаченным. Поэтому:
   * тело говорит «оплачено», API говорит «в обработке» → заказ НЕ оплачен.
   */
  it('🔴 тело говорит «оплачено», API — «в обработке»: заказ НЕ помечается оплаченным', async () => {
    atolRequestMock.mockResolvedValue({ paymentStatus: 0, amount: 100000 });

    const svc = new AtolPaymentService({ ...LIVE });
    await svc.handleCallback(paidCallback, {});

    expect(atolRequestMock).toHaveBeenCalled();
    const recorded = recordCallbackMock.mock.calls[0]?.[0] as { nextStatus: string | null };
    expect(recorded.nextStatus).not.toBe('paid');
  });

  it('API подтверждает оплату → заказ помечается оплаченным', async () => {
    atolRequestMock.mockResolvedValue({ paymentStatus: 1, amount: 100000 });

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.handleCallback(paidCallback, {});

    expect(res.accepted).toBe(true);
    const recorded = recordCallbackMock.mock.calls[0]?.[0] as { nextStatus: string | null };
    expect(recorded.nextStatus).toBe('paid');
  });

  /**
   * 🔴 Сверка суммы. Совпадения статуса мало: если API подтверждает оплату на
   * сумму меньше заказа, помечать заказ оплаченным нельзя.
   */
  it('🔴 сумма из API меньше суммы заказа → не помечаем оплаченным', async () => {
    atolRequestMock.mockResolvedValue({ paymentStatus: 1, amount: 1 });

    const svc = new AtolPaymentService({ ...LIVE });
    await svc.handleCallback(paidCallback, { expectedAmountKop: 100000 });

    const recorded = recordCallbackMock.mock.calls[0]?.[0] as { nextStatus: string | null };
    expect(recorded.nextStatus).not.toBe('paid');
  });

  /**
   * Недоступность API — не повод поверить телу callback: без подтверждения
   * статус не меняется. Но событие всё равно обязано попасть в журнал, иначе
   * оно потеряется, а крон-сверка вернётся к заказу позже.
   */
  it('сверка недоступна (API недоступен) → статус не меняем, событие пишем', async () => {
    atolRequestMock.mockRejectedValue(new Error('сеть'));

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.handleCallback(paidCallback, {});

    // Событие записано...
    expect(res.accepted).toBe(true);
    expect(recordCallbackMock).toHaveBeenCalled();
    // ...но перехода статуса при неудавшейся сверке быть не должно.
    const recorded = recordCallbackMock.mock.calls[0]?.[0] as { nextStatus: string | null };
    expect(recorded.nextStatus).toBeNull();
  });

  it('заказ не найден → штатный отказ, без исключения', async () => {
    findOrderIdByPaymentRefMock.mockResolvedValue(null);

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.handleCallback({ ...paidCallback, orderId: 'нет-такого' }, {});

    expect(res.accepted).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  /**
   * 🔴 Непробитый чек: деньги списаны, чека нет. Событие обязано попасть в
   * журнал с флагом, а не потеряться.
   */
  it('🔴 fiscal со status=fail помечается как непробитый чек', async () => {
    const svc = new AtolPaymentService({ ...LIVE });
    await svc.handleCallback(
      {
        status: 'fail',
        orderId: 'NM-1001',
        type: 'fiscal',
        receiptId: 'r-1',
        receiptType: 'sell',
        amount: 100000,
      },
      {},
    );

    const recorded = recordCallbackMock.mock.calls[0]?.[0] as {
      log: { receiptFailed?: boolean };
    };
    expect(recorded.log.receiptFailed).toBe(true);
  });

  it('успешный fiscal не поднимает флаг', async () => {
    const svc = new AtolPaymentService({ ...LIVE });
    await svc.handleCallback(
      {
        status: 'success',
        orderId: 'NM-1001',
        type: 'fiscal',
        receiptId: 'r-1',
        receiptType: 'sell',
        amount: 100000,
      },
      {},
    );

    const recorded = recordCallbackMock.mock.calls[0]?.[0] as {
      log: { receiptFailed?: boolean };
    };
    expect(recorded.log.receiptFailed).toBe(false);
  });

  /** Событие фискализации не меняет статус оплаты: это разные вещи. */
  it('fiscal не меняет payment_status', async () => {
    const svc = new AtolPaymentService({ ...LIVE });
    await svc.handleCallback(
      { status: 'success', orderId: 'NM-1001', type: 'fiscal', receiptId: 'r', receiptType: 'sell' },
      {},
    );

    const recorded = recordCallbackMock.mock.calls[0]?.[0] as { nextStatus: string | null };
    expect(recorded.nextStatus).toBeNull();
  });
});

describe('atol/service — 🔴 сверка reconcile тоже проверяет сумму', () => {
  /**
   * 🔴 У платформы ДВА пути к статусу `paid`: обработка callback и сверка
   * reconcile. Проверка суммы обязана стоять на ОБОИХ — иначе достаточно
   * пройти по тому, где её нет.
   *
   * Дефект был ровно такой: handleCallback сумму сверял, а reconcile применял
   * статус по одному paymentStatus, не заглядывая в amount.
   */
  it('🔴 подтверждённая сумма меньше суммы заказа → не помечаем оплаченным', async () => {
    atolRequestMock.mockResolvedValue({ paymentStatus: 1, amount: 1 });

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.reconcile(order({ paymentRef: 'NM-1001', grandTotal: '1000.00' }));

    expect(res.applied).toBe(false);
    expect(applyPaymentStatusMock).not.toHaveBeenCalled();
  });

  it('сумма сходится → статус применяется', async () => {
    atolRequestMock.mockResolvedValue({ paymentStatus: 1, amount: 100000 });

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.reconcile(order({ paymentRef: 'NM-1001', grandTotal: '1000.00' }));

    expect(res.applied).toBe(true);
    expect(applyPaymentStatusMock).toHaveBeenCalled();
  });

  /**
   * Переплата законна (например округление на стороне банка) — блокировать
   * зачисление из-за неё нельзя, покупатель заплатил не меньше должного.
   */
  it('переплата не мешает засчитать оплату', async () => {
    atolRequestMock.mockResolvedValue({ paymentStatus: 1, amount: 100001 });

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.reconcile(order({ paymentRef: 'NM-1001', grandTotal: '1000.00' }));

    expect(res.applied).toBe(true);
  });

  /**
   * Сверка суммы касается только перехода в `paid`: у возврата и отказа
   * сумма события законно отличается от суммы заказа.
   */
  it('возврат применяется независимо от суммы события', async () => {
    atolRequestMock.mockResolvedValue({ paymentStatus: 5, amount: 1 });

    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.reconcile(order({ paymentRef: 'NM-1001', grandTotal: '1000.00' }));

    expect(res.applied).toBe(true);
  });

  it('без payment_ref сверять нечего', async () => {
    const svc = new AtolPaymentService({ ...LIVE });
    const res = await svc.reconcile(order({ paymentRef: null }));

    expect(res.applied).toBe(false);
    expect(atolRequestMock).not.toHaveBeenCalled();
  });
});
