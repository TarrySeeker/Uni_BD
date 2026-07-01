import { describe, expect, it } from 'vitest';

import { ManualOrderSchema } from '@/lib/orders/schemas';
import {
  buildManualOrderPayload,
  createdOrderPath,
  estimateItemsTotal,
  estimateItemsTotalMinor,
  mapCreateOrderResponse,
  normalizeDelivery,
  type ManualOrderFormState,
} from '@/lib/orders/manual-order-form';

/**
 * Тесты чистого контракта ручного создания заказа из админки (Batch 4, F4).
 * Без React/БД: проверяем, что payload, собранный из состояния формы, проходит
 * ManualOrderSchema (валидные/невалидные кейсы), нормализацию доставки по типу,
 * маппинг ответа и оценку промежуточного итога (UI-подсказка, ADR-010).
 */

const VARIANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';

function baseState(overrides: Partial<ManualOrderFormState> = {}): ManualOrderFormState {
  return {
    items: [{ variantId: VARIANT, qty: 2 }],
    customer: { name: 'Иван Петров', email: 'ivan@example.com', phone: '+79990000000' },
    delivery: { type: 'courier', city: 'Москва', address: 'ул. Ленина, 1' },
    paymentMethod: 'cod',
    comment: '',
    ...overrides,
  };
}

describe('manual-order-form — buildManualOrderPayload', () => {
  it('собирает payload, проходящий ManualOrderSchema (курьер)', () => {
    const payload = buildManualOrderPayload(baseState());
    const parsed = ManualOrderSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(payload.source).toBe('admin');
  });

  it('доставка в ПВЗ с pvzCode проходит схему', () => {
    const payload = buildManualOrderPayload(
      baseState({ delivery: { type: 'pvz', city: 'Москва', pvzCode: 'MSK1' } }),
    );
    expect(ManualOrderSchema.safeParse(payload).success).toBe(true);
    expect(payload.delivery.pvzCode).toBe('MSK1');
  });

  it('ПВЗ без pvzCode НЕ проходит схему (обязательность на сервере)', () => {
    const payload = buildManualOrderPayload(
      baseState({ delivery: { type: 'pvz', city: 'Москва' } }),
    );
    expect(ManualOrderSchema.safeParse(payload).success).toBe(false);
  });

  it('самовывоз: оставляет только type, без лишних полей', () => {
    const payload = buildManualOrderPayload(
      baseState({ delivery: { type: 'pickup', city: 'Москва', address: 'игнор', pvzCode: 'игнор' } }),
    );
    expect(payload.delivery).toEqual({ type: 'pickup' });
    expect(ManualOrderSchema.safeParse(payload).success).toBe(true);
  });

  it('variantId приоритетнее productId в позиции', () => {
    const payload = buildManualOrderPayload(
      baseState({ items: [{ variantId: VARIANT, productId: PRODUCT, qty: 1 }] }),
    );
    expect(payload.items[0]).toEqual({ qty: 1, variantId: VARIANT });
    expect('productId' in payload.items[0]!).toBe(false);
  });

  it('позиция только с productId сохраняет productId', () => {
    const payload = buildManualOrderPayload(
      baseState({ items: [{ productId: PRODUCT, qty: 3 }] }),
    );
    expect(payload.items[0]).toEqual({ qty: 3, productId: PRODUCT });
    expect(ManualOrderSchema.safeParse(payload).success).toBe(true);
  });

  it('отбрасывает пустые строки позиций (без variantId/productId)', () => {
    const payload = buildManualOrderPayload(
      baseState({
        items: [
          { variantId: VARIANT, qty: 2 },
          { qty: 1 },
          { variantId: '   ', qty: 5 },
        ],
      }),
    );
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.variantId).toBe(VARIANT);
  });

  it('пустой список позиций → схема отклоняет (Корзина пуста)', () => {
    const payload = buildManualOrderPayload(baseState({ items: [{ qty: 1 }] }));
    const parsed = ManualOrderSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it('тримит контакты и опускает пустой comment', () => {
    const payload = buildManualOrderPayload(
      baseState({
        customer: { name: '  Иван  ', email: ' ivan@example.com ', phone: ' +7999 ' },
        comment: '   ',
      }),
    );
    expect(payload.customer.name).toBe('Иван');
    expect(payload.customer.email).toBe('ivan@example.com');
    expect('comment' in payload).toBe(false);
  });

  it('непустой comment сохраняется (trim)', () => {
    const payload = buildManualOrderPayload(baseState({ comment: '  срочно  ' }));
    expect(payload.comment).toBe('срочно');
  });

  it('невалидный email покупателя → схема отклоняет', () => {
    const payload = buildManualOrderPayload(
      baseState({ customer: { name: 'Иван', email: 'не-email', phone: '+7999' } }),
    );
    expect(ManualOrderSchema.safeParse(payload).success).toBe(false);
  });

  it('неизвестный способ оплаты → схема отклоняет', () => {
    const payload = buildManualOrderPayload(
      // @ts-expect-error — намеренно невалидный способ оплаты
      baseState({ paymentMethod: 'bitcoin' }),
    );
    expect(ManualOrderSchema.safeParse(payload).success).toBe(false);
  });

  it('каждый способ оплаты из whitelist проходит схему', () => {
    for (const pm of ['unset', 'cod', 'card', 'sbp', 'cdek_pay', 'invoice'] as const) {
      const payload = buildManualOrderPayload(baseState({ paymentMethod: pm }));
      expect(ManualOrderSchema.safeParse(payload).success).toBe(true);
    }
  });
});

describe('manual-order-form — normalizeDelivery', () => {
  it('courier отбрасывает pvzCode и пустые поля', () => {
    expect(
      normalizeDelivery({ type: 'courier', city: '  ', address: 'ул. 1', pvzCode: 'X' }),
    ).toEqual({ type: 'courier', address: 'ул. 1' });
  });

  it('pvz сохраняет city и pvzCode', () => {
    expect(normalizeDelivery({ type: 'pvz', city: 'СПб', pvzCode: 'SPB9' })).toEqual({
      type: 'pvz',
      city: 'СПб',
      pvzCode: 'SPB9',
    });
  });

  it('pickup → только type', () => {
    expect(normalizeDelivery({ type: 'pickup', city: 'X', address: 'Y' })).toEqual({
      type: 'pickup',
    });
  });
});

describe('manual-order-form — mapCreateOrderResponse / createdOrderPath', () => {
  it('берёт id и number из ответа экшена (терпим к лишним полям)', () => {
    const mapped = mapCreateOrderResponse({
      id: 'abc',
      number: 'TC-2026-000001',
      // @ts-expect-error — экшен также возвращает order, его игнорируем
      order: { id: 'abc' },
    });
    expect(mapped).toEqual({ id: 'abc', number: 'TC-2026-000001' });
  });

  it('createdOrderPath даёт путь карточки заказа', () => {
    expect(createdOrderPath('abc')).toBe('/admin/orders/abc');
  });
});

describe('manual-order-form — estimateItemsTotal (UI-подсказка, не источник правды)', () => {
  it('считает итог по priceOverride варианта', () => {
    // 1500.00 × 2 = 3000.00
    expect(
      estimateItemsTotalMinor([{ basePrice: '1000.00', priceOverride: '1500.00', qty: 2 }]),
    ).toBe(300000);
  });

  it('считает итог по basePrice + priceDelta', () => {
    // (1000 + 250) × 3 = 3750.00
    expect(
      estimateItemsTotalMinor([{ basePrice: '1000.00', priceDelta: '250.00', qty: 3 }]),
    ).toBe(375000);
  });

  it('итог как строка-сумма (для formatPrice)', () => {
    expect(estimateItemsTotal([{ basePrice: '1000.00', qty: 2 }])).toBe('2000.00');
  });

  it('пропускает строки с qty<=0', () => {
    expect(
      estimateItemsTotalMinor([
        { basePrice: '1000.00', qty: 0 },
        { basePrice: '500.00', qty: 1 },
      ]),
    ).toBe(50000);
  });

  it('пустой список → 0', () => {
    expect(estimateItemsTotal([])).toBe('0.00');
  });
});
