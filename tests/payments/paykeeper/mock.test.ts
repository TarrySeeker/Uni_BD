import { describe, it, expect } from 'vitest';
import {
  mockCreateInvoice,
  mockGetInvoiceStatus,
  MOCK_INVOICE_ID_PREFIX,
  MOCK_PAYMENT_URL_PATH,
} from '@/lib/payments/paykeeper/mock';

/**
 * Юнит-тесты mock-слоя PayKeeper (docs/24 §2). Детерминированные, без сети.
 */

describe('paykeeper/mock — mockCreateInvoice', () => {
  it('фейковый invoice_id с распознаваемым префиксом + is_mock', () => {
    const res = mockCreateInvoice({ orderId: 'ADMIK-2026-000001', payAmount: '1500.00' });
    expect(res.invoiceId.startsWith(MOCK_INVOICE_ID_PREFIX)).toBe(true);
    expect(res.isMock).toBe(true);
    expect(res.status).toBe('sent');
  });

  it('относительный demo-URL несёт orderId/invoiceId/amount', () => {
    const res = mockCreateInvoice({ orderId: 'ADMIK-2026-000002', payAmount: '990.50' });
    expect(res.invoiceUrl.startsWith(MOCK_PAYMENT_URL_PATH)).toBe(true);
    const q = new URL(res.invoiceUrl, 'http://x').searchParams;
    expect(q.get('orderId')).toBe('ADMIK-2026-000002');
    expect(q.get('invoiceId')).toBe(res.invoiceId);
    expect(q.get('amount')).toBe('990.50');
  });

  it('baseOrigin абсолютизирует URL', () => {
    const res = mockCreateInvoice({
      orderId: 'o',
      payAmount: '10.00',
      baseOrigin: 'https://shop.example/',
    });
    expect(res.invoiceUrl.startsWith('https://shop.example/mock/paykeeper/pay')).toBe(true);
  });

  it('returnUrl прокидывается в query', () => {
    const res = mockCreateInvoice({
      orderId: 'o',
      payAmount: '10.00',
      returnUrl: 'https://shop.example/thanks',
    });
    const q = new URL(res.invoiceUrl, 'http://x').searchParams;
    expect(q.get('returnUrl')).toBe('https://shop.example/thanks');
  });

  it('invoice_id уникален между вызовами', () => {
    const a = mockCreateInvoice({ orderId: 'o', payAmount: '1.00' });
    const b = mockCreateInvoice({ orderId: 'o', payAmount: '1.00' });
    expect(a.invoiceId).not.toBe(b.invoiceId);
  });
});

describe('paykeeper/mock — mockGetInvoiceStatus', () => {
  it('happy-path: paid (cron дотягивает зависший mock до paid)', () => {
    expect(mockGetInvoiceStatus('mock-inv-1').status).toBe('paid');
  });
});
