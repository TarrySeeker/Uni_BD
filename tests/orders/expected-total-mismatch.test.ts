import { describe, it, expect } from 'vitest';

import { CreateOrderSchema } from '@/lib/orders/schemas';
import {
  STOREFRONT_ERROR_REASONS,
  transportForReason,
  isStorefrontErrorReason,
} from '@/lib/storefront/error-reasons';

/**
 * ГРУППА «сумма на экране ≠ сумма к оплате» — аудит 2026-07-26, находки major №2
 * и major №9. Обе — ОДНА первопричина: никто не сверял итог, показанный
 * покупателю, с итогом реально созданного заказа.
 *
 * №2 (повторный submit после сбоя шлюза): `idemKeyRef` в CheckoutForm жил всю
 * жизнь компонента и не сбрасывался. Покупатель жал «Оплатить» → заказ №A создан,
 * init оплаты упал → покупатель вводил промокод (итог 12000 → 9600) → жал ещё раз
 * → createOrder уходил с ТЕМ ЖЕ Idempotency-Key → сервер возвращал reused-заказ №A
 * со СТАРЫМИ суммами → покупателя вели платить 12000 при 9600 на экране.
 *
 * №9 (сервер молча применил меньший сертификат): витрина показала «сертификат
 * покрывает весь заказ», а сервер пересчитал giftDiscount из свежего остатка
 * (баланс мог быть потрачен параллельно) и создал заказ с ненулевым grandTotal —
 * без единого предупреждения покупателю.
 *
 * РЕШЕНИЕ (сторожим здесь): НЕОБЯЗАТЕЛЬНОЕ поле `expectedGrandTotal` в теле
 * createOrder. Витрина сообщает сумму, которую ВИДИТ покупатель; сервер сверяет её
 * с фактическим итогом и при расхождении отказывает доменной причиной
 * `total_mismatch` вместо тихого создания/переиспользования заказа.
 *
 * АДДИТИВНОСТЬ: поле опционально — старый клиент, который его не шлёт, работает
 * ровно как раньше (сверка не выполняется).
 */

describe('CreateOrderSchema — expectedGrandTotal (аддитивное поле сверки)', () => {
  const base = {
    items: [{ productId: '11111111-1111-4111-8111-111111111111', qty: 1 }],
    customer: { name: 'Покупатель', email: 'buyer@example.com', phone: '+70000000000' },
    delivery: { type: 'pickup' as const },
    paymentMethod: 'card' as const,
  };

  it('🔴 поле ОПЦИОНАЛЬНО: тело без него остаётся валидным (старые клиенты)', () => {
    const parsed = CreateOrderSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.expectedGrandTotal).toBeUndefined();
    }
  });

  it('принимает денежную строку в формате NUMERIC(14,2)', () => {
    const parsed = CreateOrderSchema.safeParse({ ...base, expectedGrandTotal: '9600.00' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.expectedGrandTotal).toBe('9600.00');
    }
  });

  it('принимает ноль (полное покрытие сертификатом — платить нечего)', () => {
    const parsed = CreateOrderSchema.safeParse({ ...base, expectedGrandTotal: '0.00' });
    expect(parsed.success).toBe(true);
  });

  it('отвергает мусор и отрицательные суммы', () => {
    for (const bad of ['abc', '-100.00', '12,00', '']) {
      expect(CreateOrderSchema.safeParse({ ...base, expectedGrandTotal: bad }).success, bad).toBe(
        false,
      );
    }
  });
});

describe('публичный алфавит причин: total_mismatch', () => {
  it('🔴 причина объявлена в алфавите Storefront API', () => {
    expect(STOREFRONT_ERROR_REASONS).toContain('total_mismatch');
    expect(isStorefrontErrorReason('total_mismatch')).toBe(true);
  });

  it('расхождение суммы — КОНФЛИКТ состояния (409), а не 422', () => {
    // Тело запроса синтаксически валидно; изменилось СОСТОЯНИЕ (промокод/остаток
    // сертификата/цена). Повтор с тем же телом не поможет — нужен свежий расчёт.
    expect(transportForReason('total_mismatch')).toBe('conflict');
  });

  it('алфавит расширен строго АДДИТИВНО (прежние причины на месте)', () => {
    for (const reason of [
      'out_of_stock',
      'invalid_item',
      'invalid_promo',
      'invalid_gift',
      'delivery_unavailable',
      'invalid_zone',
      'payments_disabled',
      'order_not_found',
      'order_not_payable',
      'payment_init_failed',
      'payment_in_progress',
    ]) {
      expect(STOREFRONT_ERROR_REASONS).toContain(reason);
    }
  });
});
