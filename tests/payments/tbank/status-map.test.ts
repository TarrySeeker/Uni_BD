import { describe, it, expect } from 'vitest';
import {
  STATUS_TO_PAYMENT_STATUS,
  mapTbankStatus,
} from '@/lib/payments/tbank/status-map';
import { PAYMENT_STATUS_TRANSITIONS } from '@/lib/orders/status';
import { PAYMENT_STATUSES } from '@/lib/orders/types';
import type { PaymentStatus } from '@/lib/orders/types';

/**
 * Полная матрица Status Т-Банка → payment_status Admik (docs/15 §4.3). ЧИСТАЯ,
 * без сети/БД → всегда зелёная.
 */

const EXPECTED: Record<string, PaymentStatus> = {
  NEW: 'pending',
  FORM_SHOWED: 'pending',
  AUTHORIZING: 'pending',
  AUTHORIZED: 'authorized',
  CONFIRMING: 'authorized',
  CONFIRMED: 'paid',
  REJECTED: 'failed',
  DEADLINE_EXPIRED: 'failed',
  REVERSING: 'failed',
  REVERSED: 'failed',
  CANCELED: 'failed',
  // Только ПОЛНЫЙ возврат → 'refunded' (терминальный сетл). REFUNDING/PARTIAL_REFUNDED
  // намеренно НЕ в карте (→ null) — см. отдельный тест ниже (БАГ #5/#12 + регресс волны 15).
  REFUNDED: 'refunded',
};

describe('tbank/status-map — полная матрица Status → payment_status', () => {
  for (const [status, expected] of Object.entries(EXPECTED)) {
    it(`${status} → ${expected}`, () => {
      expect(mapTbankStatus(status)).toBe(expected);
    });
  }

  it('матрица теста охватывает все коды таблицы модуля', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(
      Object.keys(STATUS_TO_PAYMENT_STATUS).sort(),
    );
  });

  it('REFUNDING (в процессе) и PARTIAL_REFUNDED → null (НЕ терминальный сетл, БАГ #5/#12)', () => {
    // Иначе транзиентный/частичный возврат целиком закрывал бы заказ и высвобождал
    // ВЕСЬ остаток (settleRefundEffectsTx срабатывает на payment_status='refunded').
    expect(mapTbankStatus('REFUNDING')).toBeNull();
    expect(mapTbankStatus('PARTIAL_REFUNDED')).toBeNull();
    expect(mapTbankStatus('REFUNDED')).toBe('refunded');
  });

  it('каждый результат — валидный PaymentStatus', () => {
    for (const status of Object.keys(EXPECTED)) {
      const ps = mapTbankStatus(status);
      expect(ps !== null && (PAYMENT_STATUSES as readonly string[]).includes(ps)).toBe(true);
    }
  });
});

describe('tbank/status-map — неизвестные коды и регистр', () => {
  it('неизвестный/пустой код → null (вызывающий пропускает переход)', () => {
    expect(mapTbankStatus('NOPE')).toBeNull();
    expect(mapTbankStatus('')).toBeNull();
    expect(mapTbankStatus(null)).toBeNull();
    expect(mapTbankStatus(undefined)).toBeNull();
  });

  it('регистр кода нормализуется к верхнему', () => {
    expect(mapTbankStatus('confirmed')).toBe('paid');
    expect(mapTbankStatus('Authorized')).toBe('authorized');
  });
});

describe('tbank/status-map — согласованность со статус-машиной оплаты', () => {
  it('целевые статусы достижимы переходами из pending/authorized (sanity)', () => {
    // pending → paid допустим; pending → authorized → paid; paid → refunded.
    expect(PAYMENT_STATUS_TRANSITIONS.pending).toContain('paid');
    expect(PAYMENT_STATUS_TRANSITIONS.pending).toContain('authorized');
    expect(PAYMENT_STATUS_TRANSITIONS.pending).toContain('failed');
    expect(PAYMENT_STATUS_TRANSITIONS.authorized).toContain('paid');
    expect(PAYMENT_STATUS_TRANSITIONS.paid).toContain('refunded');
  });
});
