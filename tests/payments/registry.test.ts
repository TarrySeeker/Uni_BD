/**
 * Реестр платёжных провайдеров: правила выбора эквайера магазина.
 *
 * Проверяем ЧИСТУЮ функцию resolvePaymentProviderCode на подставленном окружении —
 * без сети, БД и боевых ключей.
 */

import { describe, it, expect } from 'vitest';

import {
  resolvePaymentProviderCode,
  createPaymentProvider,
  getProviderForOrder,
  knownPaymentProviders,
  DEFAULT_PAYMENT_PROVIDER,
} from '@/lib/payments/registry';

describe('payments/registry — выбор эквайера магазина', () => {
  it('явный PAYMENTS_PROVIDER имеет приоритет', () => {
    expect(resolvePaymentProviderCode({ PAYMENTS_PROVIDER: 'ozon' })).toBe('ozon');
    expect(resolvePaymentProviderCode({ PAYMENTS_PROVIDER: 'tbank' })).toBe('tbank');
  });

  it('регистр и пробелы в значении не важны', () => {
    expect(resolvePaymentProviderCode({ PAYMENTS_PROVIDER: '  OZON ' })).toBe('ozon');
  });

  /**
   * Опечатка не должна ТИХО уводить магазин на чужой эквайринг: берём дефолт
   * (и пишем предупреждение в лог), а не падаем и не молчим.
   */
  it('неизвестный код → дефолт, а не падение', () => {
    expect(resolvePaymentProviderCode({ PAYMENTS_PROVIDER: 'sberbank' })).toBe(
      DEFAULT_PAYMENT_PROVIDER,
    );
  });

  it('пусто и ключей нет → исторический дефолт tbank', () => {
    expect(resolvePaymentProviderCode({})).toBe('tbank');
    expect(DEFAULT_PAYMENT_PROVIDER).toBe('tbank');
  });

  it('известные провайдеры создаются, неизвестный — null', () => {
    for (const code of knownPaymentProviders()) {
      const p = createPaymentProvider(code);
      expect(p).not.toBeNull();
      expect(p!.code).toBe(code);
    }
    expect(createPaymentProvider('no-such-bank')).toBeNull();
  });

  /**
   * 🔴 Возврат денег идёт провайдером ЗАКАЗА, а не активным эквайером магазина:
   * эквайера могли сменить уже после оплаты. Раньше здесь был жёстко зашит
   * Т-Банк, и у магазина на другом банке возврат молча «пропускался» при
   * реально списанных деньгах.
   */
  it('провайдер заказа выбирается по orders.payment_provider', () => {
    expect(getProviderForOrder('ozon')?.code).toBe('ozon');
    expect(getProviderForOrder('tbank')?.code).toBe('tbank');
  });

  it('заказ без шлюза (наличные/по счёту) → провайдера нет', () => {
    expect(getProviderForOrder(null)).toBeNull();
    expect(getProviderForOrder('')).toBeNull();
    expect(getProviderForOrder('manual')).toBeNull();
  });
});
