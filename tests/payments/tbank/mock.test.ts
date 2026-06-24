import { describe, it, expect } from 'vitest';
import {
  mockInitPayment,
  mockGetState,
  mockCancel,
  MOCK_PAYMENT_ID_PREFIX,
  MOCK_PAYMENT_URL_PATH,
} from '@/lib/payments/tbank/mock';

/**
 * Юнит-тесты mock-операций Т-Банка (docs/15 §2.1, §8 волна 1). Без сети/БД,
 * всегда зелёные. Формат стабилен/тестируем; PaymentId уникален намеренно.
 */

describe('tbank/mock — mockInitPayment', () => {
  it('возвращает фейковый PaymentId с mock-префиксом и status NEW', () => {
    const res = mockInitPayment({ orderId: '2026-000123', amountKop: 150000 });
    expect(res.isMock).toBe(true);
    expect(res.status).toBe('NEW');
    expect(res.paymentId.startsWith(MOCK_PAYMENT_ID_PREFIX)).toBe(true);
    expect(res.paymentId).toMatch(/^mock-pay-\d{9}$/);
  });

  it('PaymentURL без origin — относительный путь demo-страницы с query', () => {
    const res = mockInitPayment({ orderId: '2026-000123', amountKop: 150000 });
    expect(res.paymentUrl.startsWith(`${MOCK_PAYMENT_URL_PATH}?`)).toBe(true);
    const url = new URL(res.paymentUrl, 'https://x.invalid');
    expect(url.searchParams.get('orderId')).toBe('2026-000123');
    expect(url.searchParams.get('paymentId')).toBe(res.paymentId);
    expect(url.searchParams.get('amount')).toBe('150000');
  });

  it('PaymentURL с origin — абсолютный (по своему домену, без хардкода)', () => {
    const res = mockInitPayment({
      orderId: 'A-1',
      amountKop: 100,
      baseOrigin: 'https://shop.example/',
    });
    expect(res.paymentUrl.startsWith('https://shop.example/mock/tbank/pay?')).toBe(true);
  });

  it('каждый Init — уникальный PaymentId', () => {
    const a = mockInitPayment({ orderId: 'x', amountKop: 1 });
    const b = mockInitPayment({ orderId: 'x', amountKop: 1 });
    expect(a.paymentId).not.toBe(b.paymentId);
  });
});

describe('tbank/mock — mockGetState / mockCancel', () => {
  it('mockGetState — happy-path CONFIRMED (для fallback-синхронизации)', () => {
    const res = mockGetState('mock-pay-123456789');
    expect(res.status).toBe('CONFIRMED');
    expect(res.isMock).toBe(true);
  });

  it('mockCancel — возврат REFUNDED по умолчанию, REVERSED для холда', () => {
    expect(mockCancel().status).toBe('REFUNDED');
    expect(mockCancel({ authorizedOnly: true }).status).toBe('REVERSED');
  });
});
