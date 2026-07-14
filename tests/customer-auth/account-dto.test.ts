import { describe, expect, it } from 'vitest';

import { toCustomerMeDto, toCustomerOrderDto } from '@/lib/storefront/account-dto';
import type { Customer } from '@/lib/customer-auth/types';
import type { CustomerOrderSummary } from '@/lib/customer-auth/repository';

/**
 * ЮНИТ — DTO ЛК (docs/24 §6). Наружу НЕ уходят внутренний id/секреты/таймстампы;
 * заказ отдаётся сводкой с русскими подписями статусов.
 */
describe('storefront/account-dto', () => {
  const customer: Customer = {
    id: 'internal-uuid',
    email: 'buyer@example.io',
    name: 'Покупатель',
    phone: '+79990000000',
    status: 'active',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: new Date('2026-02-01T00:00:00Z'),
    preferredLocale: 'en',
    ordersCount: 3,
    totalSpent: '4500.00',
    createdAt: new Date('2025-12-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
  };

  it('toCustomerMeDto: без id/password/таймстампов, emailVerified — булев', () => {
    const dto = toCustomerMeDto(customer);
    expect(dto).toEqual({
      email: 'buyer@example.io',
      name: 'Покупатель',
      phone: '+79990000000',
      status: 'active',
      emailVerified: true,
      preferredLocale: 'en',
      ordersCount: 3,
      totalSpent: '4500.00',
    });
    // Явно: внутренний id и таймстампы наружу не просачиваются.
    expect(JSON.stringify(dto)).not.toContain('internal-uuid');
    expect(Object.keys(dto)).not.toContain('id');
    expect(Object.keys(dto)).not.toContain('createdAt');
  });

  it('emailVerified=false, когда verifiedAt null', () => {
    const dto = toCustomerMeDto({ ...customer, emailVerifiedAt: null });
    expect(dto.emailVerified).toBe(false);
  });

  it('toCustomerOrderDto: сводка с русскими подписями + ISO-дата', () => {
    const summary: CustomerOrderSummary = {
      number: 'CR-1001',
      status: 'new',
      paymentStatus: 'pending',
      deliveryStatus: 'pending',
      grandTotal: '1500.00',
      currency: 'RUB',
      createdAt: new Date('2026-03-01T10:00:00Z'),
    };
    const dto = toCustomerOrderDto(summary);
    expect(dto.number).toBe('CR-1001');
    expect(typeof dto.statusLabel).toBe('string');
    expect(dto.statusLabel.length).toBeGreaterThan(0);
    expect(dto.grandTotal).toBe('1500.00');
    expect(dto.createdAt).toBe('2026-03-01T10:00:00.000Z');
  });
});
