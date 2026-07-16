import { describe, it, expect } from 'vitest';
import {
  mapOrderStatus,
  mapCallbackOperation,
  ORDER_STATUS_TO_PAYMENT_STATUS,
} from '@/lib/payments/alfabank/status-map';

/**
 * Юнит-тесты маппинга статуса Альфа-Банка → payment_status Admik. ЧИСТЫЕ, всегда
 * зелёные. Два источника: числовой orderStatus (reconcile) и operation+status (колбэк).
 */

describe('alfabank/status-map — mapOrderStatus (числовой orderStatus)', () => {
  it('0 → pending (зарегистрирован, не оплачен)', () => {
    expect(mapOrderStatus(0)).toBe('pending');
  });
  it('1 → authorized (предавторизация, hold)', () => {
    expect(mapOrderStatus(1)).toBe('authorized');
  });
  it('2 → paid (полная авторизация)', () => {
    expect(mapOrderStatus(2)).toBe('paid');
  });
  it('3 → failed (авторизация отменена/reversed)', () => {
    expect(mapOrderStatus(3)).toBe('failed');
  });
  it('4 → refunded (возврат выполнен)', () => {
    expect(mapOrderStatus(4)).toBe('refunded');
  });
  it('5 → pending (3-D Secure в процессе)', () => {
    expect(mapOrderStatus(5)).toBe('pending');
  });
  it('6 → failed (авторизация отклонена)', () => {
    expect(mapOrderStatus(6)).toBe('failed');
  });
  it('неизвестный/пустой/null → null', () => {
    expect(mapOrderStatus(99)).toBeNull();
    expect(mapOrderStatus(null)).toBeNull();
    expect(mapOrderStatus(undefined)).toBeNull();
  });
  it('карта покрывает 0..6', () => {
    expect(Object.keys(ORDER_STATUS_TO_PAYMENT_STATUS).sort()).toEqual(
      ['0', '1', '2', '3', '4', '5', '6'],
    );
  });
});

describe('alfabank/status-map — mapCallbackOperation (operation + status)', () => {
  it('deposited + status 1 → paid', () => {
    expect(mapCallbackOperation('deposited', '1')).toBe('paid');
  });
  it('approved + status 1 → authorized (hold)', () => {
    expect(mapCallbackOperation('approved', '1')).toBe('authorized');
  });
  it('reversed + status 1 → failed', () => {
    expect(mapCallbackOperation('reversed', '1')).toBe('failed');
  });
  it('refunded + status 1 → refunded', () => {
    expect(mapCallbackOperation('refunded', '1')).toBe('refunded');
  });
  it('неуспех (status != 1) → null (переход не применяется)', () => {
    expect(mapCallbackOperation('deposited', '0')).toBeNull();
    expect(mapCallbackOperation('refunded', '0')).toBeNull();
    expect(mapCallbackOperation('deposited', '')).toBeNull();
  });
  it('регистронезависимо к operation', () => {
    expect(mapCallbackOperation('DEPOSITED', '1')).toBe('paid');
    expect(mapCallbackOperation('Refunded', '1')).toBe('refunded');
  });
  it('неизвестная операция / пустая → null', () => {
    expect(mapCallbackOperation('declinedByTimeout', '1')).toBeNull();
    expect(mapCallbackOperation('', '1')).toBeNull();
    expect(mapCallbackOperation(null, '1')).toBeNull();
  });
});
