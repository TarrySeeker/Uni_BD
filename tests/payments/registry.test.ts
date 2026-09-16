/**
 * Реестр платёжных провайдеров: правила выбора эквайера магазина.
 *
 * Проверяем ЧИСТУЮ функцию resolvePaymentProviderCode на подставленном окружении —
 * без сети, БД и боевых ключей.
 */

import { describe, it, expect, vi } from 'vitest';

import type { Order } from '@/lib/orders/types';
import { AtolProviderAdapter } from '@/lib/payments/registry/adapters';
import type { AtolPaymentService } from '@/lib/payments/atol/service';

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
    expect(resolvePaymentProviderCode({ PAYMENTS_PROVIDER: 'atol' })).toBe('atol');
  });

  it('регистр и пробелы не важны и для atol', () => {
    expect(resolvePaymentProviderCode({ PAYMENTS_PROVIDER: ' AtoL  ' })).toBe('atol');
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

  /** Новый эквайер обязан быть виден реестру, иначе он мёртвый код. */
  it('atol зарегистрирован и создаётся', () => {
    expect(knownPaymentProviders()).toContain('atol');
    expect(createPaymentProvider('atol')?.code).toBe('atol');
    expect(getProviderForOrder('atol')?.code).toBe('atol');
  });
});

/**
 * Адаптер АТОЛа. Сервис подставляем через DI (дефолтный параметр конструктора) —
 * ни сети, ни боевых ключей.
 *
 * 🔴 Главное, что проверяем: refundPayment на «нечего возвращать» отдаёт
 * skipped, а НЕ бросает. Иначе админка не смогла бы отменить заказ, оплаченный
 * наличными или чужим эквайером, — контракт из lib/payments/types.ts.
 */
describe('payments/registry — AtolProviderAdapter', () => {
  const REFUND_INPUT = {
    orderId: 'order-uuid-1',
    orderNumber: '2026-000123',
    paymentStatus: 'paid',
    paymentProvider: 'atol',
    paymentRef: 'ATOL-1',
    amountKop: 150000,
  };

  /** Минимальный дубль сервиса: только то, чем пользуется адаптер. */
  function fakeService(over: Record<string, unknown> = {}) {
    return {
      isMock: false,
      initPayment: vi.fn(),
      handleCallback: vi.fn(),
      reconcile: vi.fn(),
      refund: vi.fn(() => Promise.resolve()),
      ...over,
    } as unknown as AtolPaymentService;
  }

  it('isConfigured = не mock (источник правды — сам сервис)', () => {
    expect(new AtolProviderAdapter(fakeService({ isMock: false })).isConfigured()).toBe(true);
    expect(new AtolProviderAdapter(fakeService({ isMock: true })).isConfigured()).toBe(false);
  });

  it('чужой провайдер заказа → skipped no_gateway, шлюз не дёргается', async () => {
    const svc = fakeService();
    const r = await new AtolProviderAdapter(svc).refundPayment({
      ...REFUND_INPUT,
      paymentProvider: 'tbank',
    });
    expect(r).toMatchObject({ ok: true, skipped: true, reason: 'no_gateway' });
    expect((svc as unknown as { refund: ReturnType<typeof vi.fn> }).refund).not.toHaveBeenCalled();
  });

  it('заказ без paymentRef (наличные/по счёту) → skipped, а не исключение', async () => {
    const svc = fakeService();
    const r = await new AtolProviderAdapter(svc).refundPayment({
      ...REFUND_INPUT,
      paymentProvider: null,
      paymentRef: null,
    });
    expect(r).toMatchObject({ ok: true, skipped: true, reason: 'no_gateway' });
    expect((svc as unknown as { refund: ReturnType<typeof vi.fn> }).refund).not.toHaveBeenCalled();
  });

  it('деньги не захвачены → skipped not_captured', async () => {
    const svc = fakeService();
    for (const paymentStatus of ['pending', 'failed', 'refunded']) {
      const r = await new AtolProviderAdapter(svc).refundPayment({ ...REFUND_INPUT, paymentStatus });
      expect(r).toMatchObject({ ok: true, skipped: true, reason: 'not_captured' });
    }
    expect((svc as unknown as { refund: ReturnType<typeof vi.fn> }).refund).not.toHaveBeenCalled();
  });

  /**
   * 🔴 У АТОЛа отмена и возврат — одна ручка с суммой, поэтому, в отличие от
   * Озона, возврат настоящий: сумма ОБЯЗАНА доехать до сервиса, иначе частичный
   * возврат молча превратится в полный.
   */
  it('paid/authorized → возврат вызывается С СУММОЙ', async () => {
    for (const paymentStatus of ['paid', 'authorized']) {
      const svc = fakeService();
      const r = await new AtolProviderAdapter(svc).refundPayment({ ...REFUND_INPUT, paymentStatus });
      expect(r.ok).toBe(true);
      expect(r.skipped).toBeUndefined();
      expect((svc as unknown as { refund: ReturnType<typeof vi.fn> }).refund).toHaveBeenCalledWith({
        paymentRef: 'ATOL-1',
        amountKop: 150000,
      });
    }
  });

  it('частичный возврат передаёт именно свою сумму', async () => {
    const svc = fakeService();
    await new AtolProviderAdapter(svc).refundPayment({ ...REFUND_INPUT, amountKop: 50000 });
    expect((svc as unknown as { refund: ReturnType<typeof vi.fn> }).refund).toHaveBeenCalledWith({
      paymentRef: 'ATOL-1',
      amountKop: 50000,
    });
  });

  /** Отказ ШЛЮЗА — это ok:false с причиной: деньги остались у эквайера. */
  it('шлюз отказал → ok:false с причиной, без выброса исключения', async () => {
    const svc = fakeService({ refund: vi.fn(() => Promise.reject(new Error('PAYMENT_NOT_FOUND'))) });
    const r = await new AtolProviderAdapter(svc).refundPayment(REFUND_INPUT);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.reason).toBe('PAYMENT_NOT_FOUND');
  });

  it('reconcile пробрасывается в сервис', async () => {
    const svc = fakeService({
      reconcile: vi.fn(() => Promise.resolve({ status: '1', applied: true })),
    });
    const order = { id: 'order-uuid-1' } as unknown as Order;
    await expect(new AtolProviderAdapter(svc).reconcile(order)).resolves.toEqual({
      status: '1',
      applied: true,
    });
  });
});
