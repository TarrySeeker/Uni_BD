import { describe, it, expect } from 'vitest';
import {
  getActivePaymentProvider,
  isPaymentProvider,
  PAYMENT_PROVIDERS,
  ONLINE_PAYMENT_PROVIDERS,
} from '@/lib/payments/provider';

/**
 * Юнит-тесты реестра платёжных провайдеров (docs/24 §2). Выбор активного эквайера
 * по конфигу магазина (env PAYMENTS_PROVIDER). paykeeper зарегистрирован наравне с
 * tbank/manual.
 */

const BASE = { NODE_ENV: 'test' as const };

describe('payments/provider — реестр', () => {
  it('paykeeper зарегистрирован наравне с tbank/manual', () => {
    expect(PAYMENT_PROVIDERS).toContain('tbank');
    expect(PAYMENT_PROVIDERS).toContain('manual');
    expect(PAYMENT_PROVIDERS).toContain('paykeeper');
  });

  it('online-провайдеры: tbank + paykeeper (manual без онлайн-инициации)', () => {
    expect(ONLINE_PAYMENT_PROVIDERS).toContain('paykeeper');
    expect(ONLINE_PAYMENT_PROVIDERS).toContain('tbank');
    expect(ONLINE_PAYMENT_PROVIDERS).not.toContain('manual');
  });

  it('isPaymentProvider распознаёт валидные и отклоняет прочее', () => {
    expect(isPaymentProvider('paykeeper')).toBe(true);
    expect(isPaymentProvider('tbank')).toBe(true);
    expect(isPaymentProvider('yookassa')).toBe(false);
    expect(isPaymentProvider(null)).toBe(false);
  });
});

describe('payments/provider — getActivePaymentProvider', () => {
  it('дефолт tbank при отсутствии PAYMENTS_PROVIDER', () => {
    expect(getActivePaymentProvider({ ...BASE })).toBe('tbank');
  });

  it('выбирает paykeeper по конфигу магазина', () => {
    expect(getActivePaymentProvider({ ...BASE, PAYMENTS_PROVIDER: 'paykeeper' })).toBe('paykeeper');
  });

  it('manual — валидный выбор', () => {
    expect(getActivePaymentProvider({ ...BASE, PAYMENTS_PROVIDER: 'manual' })).toBe('manual');
  });
});
