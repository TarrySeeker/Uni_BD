import { afterEach, describe, expect, it, vi } from 'vitest';

import { isOnlinePaymentMethod, ONLINE_PAYMENT_METHODS } from '@/lib/orders/repository';
import type { CreateOrderInput } from '@/lib/orders/schemas';

/**
 * Баг #33 (аудит тупиков): онлайн-оплата (card/sbp = инициация Т-Банк) при
 * ВЫКЛЮЧЕННОМ модуле payments создавала тупиковый заказ — init оплаты потом отдавал
 * 404, а заказ висел неоплачиваемым. createOrder должен отсекать такой случай
 * заранее (422 payments_disabled), не создавая заказ. Модули orders/payments
 * независимы.
 *
 * ВАЖНО (регресс-фикс ревью Batch 6): cdek_pay — оплата на ПВЗ СДЭК при получении,
 * она НЕ инициирует онлайн-платёж Т-Банк (витрина зовёт initPayment ТОЛЬКО для
 * card/sbp), поэтому модуль payments ей НЕ нужен. Ошибочное включение cdek_pay в
 * онлайн-методы блокировало легитимные заказы СДЭК-Pay у магазина без эквайринга.
 *
 * Чистый хелпер isOnlinePaymentMethod покрыт без БД. Гвард createOrder проверяем,
 * мокируя isModuleEffectivelyEnabled('payments') → false: гвард срабатывает ДО
 * любого обращения к БД, поэтому тест зелёный и без PostgreSQL.
 */

describe('orders/repository — isOnlinePaymentMethod (баг #33)', () => {
  it('онлайн-методы card/sbp (инициация Т-Банк) → true', () => {
    expect(isOnlinePaymentMethod('card')).toBe(true);
    expect(isOnlinePaymentMethod('sbp')).toBe(true);
  });

  it('cdek_pay (оплата на ПВЗ, без онлайн-инициации) → false — модуль payments не нужен', () => {
    expect(isOnlinePaymentMethod('cdek_pay')).toBe(false);
  });

  it('оффлайн-методы cod/invoice/unset → false', () => {
    expect(isOnlinePaymentMethod('cod')).toBe(false);
    expect(isOnlinePaymentMethod('invoice')).toBe(false);
    expect(isOnlinePaymentMethod('unset')).toBe(false);
  });

  it('ONLINE_PAYMENT_METHODS содержит ровно card/sbp', () => {
    expect([...ONLINE_PAYMENT_METHODS].sort()).toEqual(['card', 'sbp'].sort());
  });
});

describe('orders/repository — cdek_pay НЕ блокируется выключенным модулем payments (регресс Batch 6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('cdek_pay + payments выключен → гвард payments_disabled НЕ срабатывает', async () => {
    vi.resetModules();
    vi.doMock('@/lib/config/settings', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/config/settings')>();
      return { ...actual, isModuleEffectivelyEnabled: vi.fn(async () => false) };
    });

    const { createOrder } = await import('@/lib/orders/repository');
    let res: Awaited<ReturnType<typeof createOrder>> | undefined;
    try {
      res = await createOrder({ ...ONLINE_INPUT, paymentMethod: 'cdek_pay' });
    } catch {
      // Прошёл гвард payments и упёрся в отсутствие PostgreSQL — это и означает,
      // что cdek_pay НЕ отсекается модулем payments. Тест зелёный.
      return;
    }
    // Если вернулся результат — он не должен быть payments_disabled.
    expect(res.ok ? null : res.code).not.toBe('payments_disabled');
  });
});

const ONLINE_INPUT: CreateOrderInput = {
  items: [{ variantId: '11111111-1111-4111-8111-111111111111', qty: 1 }],
  customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79990000000' },
  delivery: { type: 'courier', city: 'Москва', address: 'ул. Ленина, 1' },
  paymentMethod: 'card',
};

describe('orders/repository — createOrder отсекает онлайн-оплату при payments off (баг #33)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('card + payments выключен → ok:false, code=payments_disabled (заказ НЕ создаётся)', async () => {
    // Сбрасываем реестр модулей ДО doMock, чтобы свежий импорт repository подхватил
    // замоканный isModuleEffectivelyEnabled (статический импорт настроек иначе кеширован).
    vi.resetModules();
    vi.doMock('@/lib/config/settings', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/config/settings')>();
      return { ...actual, isModuleEffectivelyEnabled: vi.fn(async () => false) };
    });

    const { createOrder } = await import('@/lib/orders/repository');
    const res = await createOrder(ONLINE_INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('payments_disabled');
      expect(res.message).toMatch(/онлайн|оплат/i);
    }
  });
});
