import { describe, expect, it, vi } from 'vitest';

import { createGiftAutoIssuer } from '@/lib/gift-certificates/auto-issue';

/**
 * ЮНИТ (без БД): заказ, РОЖДЁННЫЙ ОПЛАЧЕННЫМ сертификатом (путь fullyGiftCovered
 * в createOrder — grand_total = 0, payment_status='paid', provider='manual',
 * минуя статус-машину). Именно отсюда lib/orders зовёт автовыпуск после коммита,
 * а решение «выпускать ли по такому заказу» принимает настройка
 * gift.allowIssueOnGiftPaidOrder (обмен номинала). Тест сторожит ОБА значения.
 */

function deps(over: {
  allowIssueOnGiftPaidOrder: boolean;
  insertGiftTx?: ReturnType<typeof vi.fn>;
}) {
  const insertGiftTx = over.insertGiftTx ?? vi.fn(async () => ({ id: 'gc-new', code: 'X' }));
  return {
    insertGiftTx,
    all: {
      getGiftSettings: async () => ({
        autoIssue: true,
        allowIssueOnGiftPaidOrder: over.allowIssueOnGiftPaidOrder,
      }),
      getOrderForAutoIssue: async () => ({
        orderId: 'o-1',
        orderNumber: 'GA-2026-000001',
        status: 'new',
        paymentStatus: 'paid',
        paidAt: new Date('2026-07-01T00:00:00Z'),
        customerId: null,
        customerName: 'Иван',
        customerEmail: 'i@shop.io',
        customerPhone: null,
        // Заказ ПОЛНОСТЬЮ оплачен другим сертификатом.
        giftCertificateId: 'gc-old',
        items: [
          {
            id: 'oi-1',
            nameSnapshot: 'Сертификат 1000',
            skuSnapshot: 'GC-1000',
            attributesSnapshot: { gift_certificate: true },
            unitPrice: '1000.00',
            quantity: 1,
            lineTotal: '1000.00',
          },
        ],
      }),
      withTransaction: async <T>(fn: (tx: never) => Promise<T>) => fn({} as never),
      lockOrderTx: async () => {},
      insertGiftTx,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      randomCode: () => 'AAAA-BBBB',
    },
  };
}

describe('fullyGiftCovered: выпуск по заказу, оплаченному сертификатом', () => {
  it('allowIssueOnGiftPaidOrder=true (дефолт платформы) → код выпускается', async () => {
    const d = deps({ allowIssueOnGiftPaidOrder: true });
    const issuer = createGiftAutoIssuer(d.all as never);
    const report = await issuer.autoIssueGiftsForPaidOrder('o-1');
    expect(report.issued).toBe(1);
    expect(d.insertGiftTx).toHaveBeenCalledTimes(1);
  });

  it('allowIssueOnGiftPaidOrder=false → выпуск не происходит (номинал не крутится по кругу)', async () => {
    const d = deps({ allowIssueOnGiftPaidOrder: false });
    const issuer = createGiftAutoIssuer(d.all as never);
    const report = await issuer.autoIssueGiftsForPaidOrder('o-1');
    expect(report.issued).toBe(0);
    expect(report.reason).toBe('paid_with_gift');
    expect(d.insertGiftTx).not.toHaveBeenCalled();
  });
});
