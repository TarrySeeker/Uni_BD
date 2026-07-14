import { describe, it, expect } from 'vitest';
import { mapPaykeeperStatus, STATUS_TO_PAYMENT_STATUS } from '@/lib/payments/paykeeper/status-map';

/**
 * Юнит-тесты маппинга статуса PayKeeper → payment_status Admik (docs/24 §2).
 * ЧИСТЫЕ, всегда зелёные.
 */

describe('paykeeper/status-map — mapPaykeeperStatus', () => {
  it('paid / синтетический PAID → paid', () => {
    expect(mapPaykeeperStatus('paid')).toBe('paid');
    expect(mapPaykeeperStatus('PAID')).toBe('paid');
    expect(mapPaykeeperStatus('Paid')).toBe('paid');
  });

  it('new / waiting / pending / sent → pending', () => {
    for (const s of ['new', 'waiting', 'pending', 'sent']) {
      expect(mapPaykeeperStatus(s)).toBe('pending');
    }
  });

  it('expired / cancelled / canceled / fail / failed / error → failed', () => {
    for (const s of ['expired', 'cancelled', 'canceled', 'fail', 'failed', 'error']) {
      expect(mapPaykeeperStatus(s)).toBe('failed');
    }
  });

  it('refunded / reversed / returned → refunded', () => {
    for (const s of ['refunded', 'reversed', 'returned']) {
      expect(mapPaykeeperStatus(s)).toBe('refunded');
    }
  });

  it('регистронезависимо (UPPER/Mixed нормализуется)', () => {
    expect(mapPaykeeperStatus('EXPIRED')).toBe('failed');
    expect(mapPaykeeperStatus('Refunded')).toBe('refunded');
    expect(mapPaykeeperStatus('SENT')).toBe('pending');
  });

  it('неизвестный / пустой / null / undefined → null', () => {
    expect(mapPaykeeperStatus('whatever')).toBeNull();
    expect(mapPaykeeperStatus('')).toBeNull();
    expect(mapPaykeeperStatus(null)).toBeNull();
    expect(mapPaykeeperStatus(undefined)).toBeNull();
  });

  it('карта покрывает только известные значения (без authorized — у PayKeeper нет hold)', () => {
    expect(Object.values(STATUS_TO_PAYMENT_STATUS)).not.toContain('authorized');
  });
});
