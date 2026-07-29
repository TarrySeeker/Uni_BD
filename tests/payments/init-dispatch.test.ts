import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Тесты ДИСПЕТЧЕРА ИНИЦИАЦИИ ОПЛАТЫ (`lib/payments/init-dispatch.ts`).
 *
 * ДЕФЕКТ (аудит, major №1): `getActivePaymentProvider()` был объявлен, но НЕ
 * вызывался нигде в продакшн-коде — витрина ходила ЖЁСТКО в
 * `/payments/paykeeper/init`, а роуты tbank/alfabank были из витрины недостижимы.
 * При дефолтном `PAYMENTS_PROVIDER=tbank` и пустых ключах PayKeeper покупателя
 * уводило на mock-страницу PayKeeper, где кнопка «Оплатить (демо)» помечала заказ
 * оплаченным БЕЗ денег и запускала автовыпуск подарочных сертификатов.
 *
 * Диспетчер — зеркало refund-диспетчера (`lib/payments/dispatch.ts`): exhaustive
 * switch по провайдеру, никакого «дефолта в tbank» для неизвестного значения.
 */

const ORDER = { id: 'o1', number: 'ADMIK-2026-000042', grandTotal: '1500.00' };

function serviceMocks() {
  const tbank = vi.fn(async () => ({
    paymentId: 'tb-1',
    paymentUrl: 'http://x/mock/tbank/pay',
    status: 'NEW',
    isMock: true,
  }));
  const paykeeper = vi.fn(async () => ({
    invoiceId: 'pk-1',
    paymentUrl: 'http://x/mock/paykeeper/pay',
    status: 'pending',
    isMock: true,
  }));
  const alfabank = vi.fn(async () => ({
    paymentId: 'af-1',
    paymentUrl: 'http://x/mock/alfabank/pay',
    status: 'registered',
    isMock: false,
  }));
  return { tbank, paykeeper, alfabank };
}

async function loadDispatch(m: ReturnType<typeof serviceMocks>) {
  vi.resetModules();
  vi.doMock('@/lib/payments/tbank/service', () => ({
    PaymentService: class {
      initPayment = m.tbank;
    },
  }));
  vi.doMock('@/lib/payments/paykeeper/service', () => ({
    PaymentService: class {
      initPayment = m.paykeeper;
    },
  }));
  vi.doMock('@/lib/payments/alfabank/service', () => ({
    PaymentService: class {
      initPayment = m.alfabank;
    },
  }));
  return import('@/lib/payments/init-dispatch');
}

describe('dispatchInitPayment — маршрутизация по АКТИВНОМУ провайдеру', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/payments/tbank/service');
    vi.doUnmock('@/lib/payments/paykeeper/service');
    vi.doUnmock('@/lib/payments/alfabank/service');
  });

  it('🔴 provider=tbank → зовётся ТОЛЬКО tbank-сервис', async () => {
    const m = serviceMocks();
    const { dispatchInitPayment } = await loadDispatch(m);
    const res = await dispatchInitPayment('tbank', ORDER as never, [], {});
    expect(m.tbank).toHaveBeenCalledTimes(1);
    expect(m.paykeeper).not.toHaveBeenCalled();
    expect(m.alfabank).not.toHaveBeenCalled();
    expect(res.provider).toBe('tbank');
    expect(res.paymentId).toBe('tb-1');
    expect(res.paymentUrl).toBe('http://x/mock/tbank/pay');
    expect(res.isMock).toBe(true);
  });

  it('🔴 provider=paykeeper → paykeeper-сервис, invoiceId нормализован в paymentId', async () => {
    const m = serviceMocks();
    const { dispatchInitPayment } = await loadDispatch(m);
    const res = await dispatchInitPayment('paykeeper', ORDER as never, [], {});
    expect(m.paykeeper).toHaveBeenCalledTimes(1);
    expect(m.tbank).not.toHaveBeenCalled();
    expect(res.provider).toBe('paykeeper');
    expect(res.paymentId).toBe('pk-1');
    // Провайдер-специфичный ключ сохранён для обратной совместимости роута.
    expect(res.invoiceId).toBe('pk-1');
  });

  it('🔴 provider=alfabank → alfabank-сервис', async () => {
    const m = serviceMocks();
    const { dispatchInitPayment } = await loadDispatch(m);
    const res = await dispatchInitPayment('alfabank', ORDER as never, [], {});
    expect(m.alfabank).toHaveBeenCalledTimes(1);
    expect(m.tbank).not.toHaveBeenCalled();
    expect(m.paykeeper).not.toHaveBeenCalled();
    expect(res.provider).toBe('alfabank');
    expect(res.paymentId).toBe('af-1');
    expect(res.isMock).toBe(false);
  });

  it('опции (baseOrigin/returnUrl) прокидываются в сервис без изменений', async () => {
    const m = serviceMocks();
    const { dispatchInitPayment } = await loadDispatch(m);
    await dispatchInitPayment('tbank', ORDER as never, [], {
      baseOrigin: 'https://admin.example.com',
      returnUrl: 'https://shop.example.com/ru/cart/success',
    });
    const [, , opts] = m.tbank.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { baseOrigin?: string; returnUrl?: string },
    ];
    expect(opts.baseOrigin).toBe('https://admin.example.com');
    expect(opts.returnUrl).toBe('https://shop.example.com/ru/cart/success');
  });
});

describe('dispatchInitPayment — офлайн/неизвестный провайдер НЕ уходит в чужой шлюз', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/payments/tbank/service');
    vi.doUnmock('@/lib/payments/paykeeper/service');
    vi.doUnmock('@/lib/payments/alfabank/service');
  });

  it('🔴 provider=manual → PaymentInitUnavailableError, ни один шлюз НЕ вызван', async () => {
    const m = serviceMocks();
    const { dispatchInitPayment, PaymentInitUnavailableError } = await loadDispatch(m);
    await expect(dispatchInitPayment('manual', ORDER as never, [], {})).rejects.toBeInstanceOf(
      PaymentInitUnavailableError,
    );
    expect(m.tbank).not.toHaveBeenCalled();
    expect(m.paykeeper).not.toHaveBeenCalled();
    expect(m.alfabank).not.toHaveBeenCalled();
  });

  it('🔴 неизвестный провайдер НЕ дефолтит в tbank (деньги в чужой шлюз)', async () => {
    const m = serviceMocks();
    const { dispatchInitPayment } = await loadDispatch(m);
    await expect(
      dispatchInitPayment('sberbank' as never, ORDER as never, [], {}),
    ).rejects.toBeTruthy();
    expect(m.tbank).not.toHaveBeenCalled();
  });
});

describe('isOnlinePaymentProvider — предикат онлайн-инициации', () => {
  it('online = tbank/paykeeper/alfabank; manual и мусор — нет', async () => {
    const { isOnlinePaymentProvider } = await import('@/lib/payments/provider');
    expect(isOnlinePaymentProvider('tbank')).toBe(true);
    expect(isOnlinePaymentProvider('paykeeper')).toBe(true);
    expect(isOnlinePaymentProvider('alfabank')).toBe(true);
    expect(isOnlinePaymentProvider('manual')).toBe(false);
    expect(isOnlinePaymentProvider('sberbank')).toBe(false);
    expect(isOnlinePaymentProvider(undefined)).toBe(false);
  });
});
