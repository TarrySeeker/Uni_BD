import { describe, it, expect } from 'vitest';
import {
  getActivePaymentProvider,
  isPaymentProvider,
  PAYMENT_PROVIDERS,
  ONLINE_PAYMENT_PROVIDERS,
} from '@/lib/payments/provider';

/**
 * Юнит-тесты реестра платёжных провайдеров с alfabank. КЛЮЧЕВОЕ (решение владельца):
 * alfabank — ДОПОЛНИТЕЛЬНАЯ опция, дефолт НЕ меняется (остаётся tbank); alfabank
 * выбирается лишь явным PAYMENTS_PROVIDER=alfabank.
 */

const BASE = { NODE_ENV: 'test' as const };

describe('payments/provider — реестр содержит alfabank', () => {
  it('alfabank зарегистрирован наравне с tbank/paykeeper/manual', () => {
    expect(PAYMENT_PROVIDERS).toContain('tbank');
    expect(PAYMENT_PROVIDERS).toContain('paykeeper');
    expect(PAYMENT_PROVIDERS).toContain('alfabank');
    expect(PAYMENT_PROVIDERS).toContain('manual');
  });

  it('alfabank — online-провайдер (с онлайн-инициацией)', () => {
    expect(ONLINE_PAYMENT_PROVIDERS).toContain('alfabank');
    expect(ONLINE_PAYMENT_PROVIDERS).not.toContain('manual');
  });

  it('isPaymentProvider распознаёт alfabank', () => {
    expect(isPaymentProvider('alfabank')).toBe(true);
    expect(isPaymentProvider('yookassa')).toBe(false);
  });
});

describe('payments/provider — дефолт НЕ изменён (решение владельца)', () => {
  it('дефолт остаётся tbank при отсутствии PAYMENTS_PROVIDER (alfabank НЕ дефолт)', () => {
    expect(getActivePaymentProvider({ ...BASE })).toBe('tbank');
  });

  it('alfabank выбирается ТОЛЬКО явным PAYMENTS_PROVIDER=alfabank', () => {
    expect(getActivePaymentProvider({ ...BASE, PAYMENTS_PROVIDER: 'alfabank' })).toBe('alfabank');
  });

  it('paykeeper по-прежнему выбираем явно (основной эквайринг carre)', () => {
    expect(getActivePaymentProvider({ ...BASE, PAYMENTS_PROVIDER: 'paykeeper' })).toBe('paykeeper');
  });
});
