import { describe, it, expect } from 'vitest';
import {
  mockRegisterOrder,
  mockGetOrderStatus,
  mockRefund,
  MOCK_ORDER_ID_PREFIX,
  MOCK_PAYMENT_URL_PATH,
} from '@/lib/payments/alfabank/mock';

/**
 * Юнит-тесты mock-слоя Альфа-Банка. Детерминированные, без сети.
 */

describe('alfabank/mock — mockRegisterOrder', () => {
  it('фейковый orderId с распознаваемым префиксом + is_mock', () => {
    const res = mockRegisterOrder({ orderNumber: 'ADMIK-2026-000001', amountKop: 150000 });
    expect(res.orderId.startsWith(MOCK_ORDER_ID_PREFIX)).toBe(true);
    expect(res.isMock).toBe(true);
    expect(res.status).toBe('registered');
  });

  it('относительный demo-formUrl несёт orderNumber/orderId/amount (в копейках)', () => {
    const res = mockRegisterOrder({ orderNumber: 'ADMIK-2026-000002', amountKop: 99050 });
    expect(res.formUrl.startsWith(MOCK_PAYMENT_URL_PATH)).toBe(true);
    const q = new URL(res.formUrl, 'http://x').searchParams;
    expect(q.get('orderNumber')).toBe('ADMIK-2026-000002');
    expect(q.get('orderId')).toBe(res.orderId);
    expect(q.get('amount')).toBe('99050');
  });

  it('baseOrigin абсолютизирует formUrl', () => {
    const res = mockRegisterOrder({
      orderNumber: 'o',
      amountKop: 1000,
      baseOrigin: 'https://shop.example/',
    });
    expect(res.formUrl.startsWith('https://shop.example/mock/alfabank/pay')).toBe(true);
  });

  it('returnUrl прокидывается в query', () => {
    const res = mockRegisterOrder({
      orderNumber: 'o',
      amountKop: 1000,
      returnUrl: 'https://shop.example/thanks',
    });
    const q = new URL(res.formUrl, 'http://x').searchParams;
    expect(q.get('returnUrl')).toBe('https://shop.example/thanks');
  });

  it('orderId уникален между вызовами', () => {
    const a = mockRegisterOrder({ orderNumber: 'o', amountKop: 100 });
    const b = mockRegisterOrder({ orderNumber: 'o', amountKop: 100 });
    expect(a.orderId).not.toBe(b.orderId);
  });
});

describe('alfabank/mock — mockGetOrderStatus / mockRefund', () => {
  it('happy-path: orderStatus 2 (paid) — cron дотягивает зависший mock до paid', () => {
    expect(mockGetOrderStatus('mock-alfa-1').orderStatus).toBe(2);
  });

  it('mockRefund → errorCode 0 (успех)', () => {
    expect(mockRefund().errorCode).toBe('0');
    expect(mockRefund({ authorizedOnly: true }).errorCode).toBe('0');
  });
});
