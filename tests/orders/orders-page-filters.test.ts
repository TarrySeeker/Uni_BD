import { describe, expect, it } from 'vitest';

import { hasActiveOrderFilters } from '@/app/admin/(panel)/orders/page';

/**
 * Баг #3 (аудит тупиков): пустой список заказов всегда советовал «измените
 * фильтры», даже когда фильтров нет и магазин новый. hasActiveOrderFilters
 * разветвляет пустое состояние: есть фильтры → «сбросьте»; нет → «заказов пока нет».
 */

describe('orders page — hasActiveOrderFilters (баг #3)', () => {
  it('без фильтров (только page) → false', () => {
    expect(hasActiveOrderFilters({ page: 1 })).toBe(false);
    expect(hasActiveOrderFilters({ page: 3 })).toBe(false);
  });

  it('любой заданный фильтр → true', () => {
    expect(hasActiveOrderFilters({ page: 1, q: 'TC-1' })).toBe(true);
    expect(hasActiveOrderFilters({ page: 1, status: 'paid' })).toBe(true);
    expect(hasActiveOrderFilters({ page: 1, paymentStatus: 'pending' })).toBe(true);
    expect(hasActiveOrderFilters({ page: 1, deliveryType: 'courier' })).toBe(true);
    expect(hasActiveOrderFilters({ page: 1, promoCode: 'SALE' })).toBe(true);
    expect(hasActiveOrderFilters({ page: 1, dateFrom: '2026-01-01' })).toBe(true);
    expect(hasActiveOrderFilters({ page: 1, dateTo: '2026-12-31' })).toBe(true);
  });
});
