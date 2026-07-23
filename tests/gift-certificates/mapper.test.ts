import { describe, it, expect } from 'vitest';

import { mapGiftCertificate, mapGiftParty } from '@/lib/gift-certificates/repository';

/**
 * ЮНИТ — маппер row→domain для расширения 0054 (стороны сделки + происхождение
 * выпуска). Без БД: на вход подаётся сырая строка, как её вернул postgres.js.
 */

const baseRow: Record<string, unknown> = {
  id: 'c1',
  code: 'GIFT500',
  name: 'Сертификат',
  description: null,
  terms: null,
  initial_amount: '5000.00',
  spent_total: '1000.00',
  currency: 'RUB',
  status: 'active',
  valid_until: null,
  translations: {},
  comment: '',
  created_at: new Date('2026-07-01T00:00:00Z'),
  updated_at: new Date('2026-07-01T00:00:00Z'),
};

describe('mapGiftParty — снимок стороны сделки', () => {
  it('читает колонки по префиксу, пустые строки → null', () => {
    const row = {
      purchaser_name: 'Иван',
      purchaser_email: 'ivan@shop.io',
      purchaser_phone: '   ',
      recipient_name: null,
      recipient_email: undefined,
      recipient_phone: '+79990000000',
    };
    expect(mapGiftParty(row, 'purchaser')).toEqual({
      name: 'Иван',
      email: 'ivan@shop.io',
      phone: null,
    });
    expect(mapGiftParty(row, 'recipient')).toEqual({
      name: null,
      email: null,
      phone: '+79990000000',
    });
  });
});

describe('mapGiftCertificate — расширение 0054', () => {
  it('исторические строки без новых колонок → пустые снимки и null-происхождение', () => {
    const cert = mapGiftCertificate({ ...baseRow });
    expect(cert.purchaser).toEqual({ name: null, email: null, phone: null });
    expect(cert.recipient).toEqual({ name: null, email: null, phone: null });
    expect(cert.purchaserCustomerId).toBeNull();
    expect(cert.issuedOrderId).toBeNull();
    expect(cert.issuedOrderItemId).toBeNull();
    expect(cert.issueSource).toBeNull();
    // Старые поля не пострадали.
    expect(cert.remaining).toBe('4000.00');
  });

  it('сертификат, выпущенный по заказу: стороны + происхождение', () => {
    const cert = mapGiftCertificate({
      ...baseRow,
      purchaser_name: 'Пётр',
      purchaser_email: 'p@shop.io',
      purchaser_phone: '+7999',
      purchaser_customer_id: 'cust-1',
      recipient_name: 'Мария',
      recipient_email: 'm@shop.io',
      recipient_phone: null,
      issued_order_id: 'ord-1',
      issued_order_item_id: 'item-1',
      issue_source: 'order',
    });
    expect(cert.purchaser).toEqual({ name: 'Пётр', email: 'p@shop.io', phone: '+7999' });
    expect(cert.purchaserCustomerId).toBe('cust-1');
    expect(cert.recipient).toEqual({ name: 'Мария', email: 'm@shop.io', phone: null });
    expect(cert.issuedOrderId).toBe('ord-1');
    expect(cert.issuedOrderItemId).toBe('item-1');
    expect(cert.issueSource).toBe('order');
  });
});
