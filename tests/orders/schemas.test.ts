import { describe, expect, it } from 'vitest';

import {
  CartQuoteSchema,
  ChangeOrderStatusSchema,
  CreateOrderSchema,
  ManualOrderSchema,
  PromoCreateSchema,
  PromoUpdateSchema,
  SetDeliveryStatusSchema,
  SetPaymentStatusSchema,
  allowedTargetTypesForScope,
  cartLineSchema,
  moneySchema,
  quantitySchema,
} from '@/lib/orders/schemas';

/**
 * Тесты Zod-схем модуля orders (docs/07 §4) — всегда зелёные (без БД).
 * Покрывают валидные/невалидные кейсы quote/создания заказа/смены статуса/CRUD
 * промокодов; валидацию денег (≥0) и количества (≥1).
 */

const UUID = '11111111-1111-4111-8111-111111111111';

describe('orders/schemas — примитивы', () => {
  it('moneySchema принимает неотрицательные суммы ≤ 2 знаков', () => {
    expect(moneySchema.safeParse('0').success).toBe(true);
    expect(moneySchema.safeParse('100').success).toBe(true);
    expect(moneySchema.safeParse('100.50').success).toBe(true);
  });

  it('moneySchema отклоняет минус, 3 знака, мусор', () => {
    expect(moneySchema.safeParse('-1').success).toBe(false);
    expect(moneySchema.safeParse('1.234').success).toBe(false);
    expect(moneySchema.safeParse('abc').success).toBe(false);
  });

  it('quantitySchema требует целое ≥ 1', () => {
    expect(quantitySchema.safeParse(1).success).toBe(true);
    expect(quantitySchema.safeParse(0).success).toBe(false);
    expect(quantitySchema.safeParse(-3).success).toBe(false);
    expect(quantitySchema.safeParse(1.5).success).toBe(false);
  });

  it('quantitySchema имеет верхнюю границу (.max 10000) — защита от потери точности', () => {
    expect(quantitySchema.safeParse(10000).success).toBe(true);
    expect(quantitySchema.safeParse(10001).success).toBe(false);
    expect(quantitySchema.safeParse(1_000_000_000).success).toBe(false);
  });

  it('cartLineSchema требует variantId или productId', () => {
    expect(cartLineSchema.safeParse({ variantId: UUID, qty: 2 }).success).toBe(true);
    expect(cartLineSchema.safeParse({ productId: UUID, qty: 1 }).success).toBe(true);
    expect(cartLineSchema.safeParse({ qty: 1 }).success).toBe(false);
  });

  it('cartLineSchema НЕ принимает цену из тела (anti-tamper)', () => {
    const parsed = cartLineSchema.parse({ variantId: UUID, qty: 1, unitPrice: '0.01' } as never);
    expect('unitPrice' in (parsed as Record<string, unknown>)).toBe(false);
  });
});

describe('orders/schemas — CartQuoteSchema (POST /cart/quote)', () => {
  it('принимает корзину с позициями и опц. промокодом/доставкой', () => {
    const res = CartQuoteSchema.safeParse({
      items: [{ variantId: UUID, qty: 2 }],
      promoCode: 'SALE10',
      delivery: { type: 'courier', city: 'Москва' },
    });
    expect(res.success).toBe(true);
  });

  it('отклоняет пустую корзину', () => {
    expect(CartQuoteSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('items-массив имеет верхнюю границу (.max 200)', () => {
    const make = (n: number) =>
      Array.from({ length: n }, () => ({ variantId: UUID, qty: 1 }));
    expect(CartQuoteSchema.safeParse({ items: make(200) }).success).toBe(true);
    expect(CartQuoteSchema.safeParse({ items: make(201) }).success).toBe(false);
  });

  it('доставка в ПВЗ требует pvzCode', () => {
    expect(
      CartQuoteSchema.safeParse({
        items: [{ variantId: UUID, qty: 1 }],
        delivery: { type: 'pvz', city: 'Москва' },
      }).success,
    ).toBe(false);
    expect(
      CartQuoteSchema.safeParse({
        items: [{ variantId: UUID, qty: 1 }],
        delivery: { type: 'pvz', city: 'Москва', pvzCode: 'MSK1' },
      }).success,
    ).toBe(true);
  });

  // BUG #3: курьерская доставка несёт назначение городом — схема принимает
  // опц. числовой cityCode (точный код СДЭК) рядом со строковым city.
  it('доставка принимает опц. числовой cityCode (BUG #3)', () => {
    const res = CartQuoteSchema.safeParse({
      items: [{ variantId: UUID, qty: 1 }],
      delivery: { type: 'courier', city: 'Москва', cityCode: 44 },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.delivery?.cityCode).toBe(44);
    }
  });

  it('cityCode должен быть положительным целым', () => {
    expect(
      CartQuoteSchema.safeParse({
        items: [{ variantId: UUID, qty: 1 }],
        delivery: { type: 'courier', cityCode: -5 },
      }).success,
    ).toBe(false);
    expect(
      CartQuoteSchema.safeParse({
        items: [{ variantId: UUID, qty: 1 }],
        delivery: { type: 'courier', cityCode: 1.5 },
      }).success,
    ).toBe(false);
  });
});

describe('orders/schemas — CreateOrderSchema (POST /orders)', () => {
  const base = {
    items: [{ variantId: UUID, qty: 1 }],
    customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79990000000' },
    delivery: { type: 'courier', city: 'Москва', address: 'ул. 1' },
    paymentMethod: 'cod',
  };

  it('принимает валидный заказ', () => {
    expect(CreateOrderSchema.safeParse(base).success).toBe(true);
  });

  it('отклоняет невалидный email покупателя', () => {
    expect(
      CreateOrderSchema.safeParse({ ...base, customer: { ...base.customer, email: 'не-email' } })
        .success,
    ).toBe(false);
  });

  it('отклоняет неизвестный способ оплаты', () => {
    expect(CreateOrderSchema.safeParse({ ...base, paymentMethod: 'bitcoin' }).success).toBe(false);
  });

  it('принимает опц. idempotencyKey', () => {
    const res = CreateOrderSchema.safeParse({ ...base, idempotencyKey: 'idem-123' });
    expect(res.success).toBe(true);
  });

  it('items-массив имеет верхнюю границу (.max 200)', () => {
    const make = (n: number) =>
      Array.from({ length: n }, () => ({ variantId: UUID, qty: 1 }));
    expect(CreateOrderSchema.safeParse({ ...base, items: make(200) }).success).toBe(true);
    expect(CreateOrderSchema.safeParse({ ...base, items: make(201) }).success).toBe(false);
  });

  it('qty выше верхней границы (>10000) отклоняется', () => {
    expect(
      CreateOrderSchema.safeParse({ ...base, items: [{ variantId: UUID, qty: 10001 }] }).success,
    ).toBe(false);
  });
});

describe('orders/schemas — смена статусов', () => {
  it('ChangeOrderStatusSchema принимает валидный целевой статус', () => {
    expect(ChangeOrderStatusSchema.safeParse({ id: UUID, to: 'paid' }).success).toBe(true);
    expect(ChangeOrderStatusSchema.safeParse({ id: UUID, to: 'bogus' }).success).toBe(false);
  });

  it('SetPaymentStatusSchema/ SetDeliveryStatusSchema ограничены своими литералами', () => {
    expect(SetPaymentStatusSchema.safeParse({ id: UUID, to: 'paid' }).success).toBe(true);
    expect(SetPaymentStatusSchema.safeParse({ id: UUID, to: 'shipped' }).success).toBe(false);
    expect(SetDeliveryStatusSchema.safeParse({ id: UUID, to: 'in_transit' }).success).toBe(true);
    expect(SetDeliveryStatusSchema.safeParse({ id: UUID, to: 'paid' }).success).toBe(false);
  });

  it('требует валидный uuid', () => {
    expect(ChangeOrderStatusSchema.safeParse({ id: 'not-uuid', to: 'paid' }).success).toBe(false);
  });
});

describe('orders/schemas — промокоды CRUD', () => {
  it('PromoCreateSchema принимает корректный percent-промокод', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'SALE10',
      kind: 'percent',
      value: '10',
      minOrderTotal: '1000',
    });
    expect(res.success).toBe(true);
  });

  it('percent > 100 отклоняется', () => {
    expect(
      PromoCreateSchema.safeParse({ code: 'X', kind: 'percent', value: '150' }).success,
    ).toBe(false);
  });

  it('отрицательные суммы отклоняются (money ≥ 0)', () => {
    expect(
      PromoCreateSchema.safeParse({ code: 'X', kind: 'fixed', value: '-5' }).success,
    ).toBe(false);
  });

  it('неизвестный kind отклоняется', () => {
    expect(PromoCreateSchema.safeParse({ code: 'X', kind: 'mystery' }).success).toBe(false);
  });

  it('ends_at раньше starts_at отклоняется', () => {
    expect(
      PromoCreateSchema.safeParse({
        code: 'X',
        kind: 'fixed',
        value: '100',
        startsAt: '2026-02-01',
        endsAt: '2026-01-01',
      }).success,
    ).toBe(false);
  });

  it('endsAt из <input type=date> = ВКЛЮЧИТЕЛЬНЫЙ конец дня (промокод жив весь последний день)', () => {
    const p = PromoCreateSchema.parse({ code: 'X', kind: 'fixed', value: '100', endsAt: '2026-06-30' });
    // 2026-06-30 → конец дня UTC, а не полночь (иначе истекал бы в начале 30 июня).
    expect((p.endsAt as Date).toISOString()).toBe('2026-06-30T23:59:59.999Z');
    // startsAt остаётся началом дня (старт даты — корректно).
    const p2 = PromoCreateSchema.parse({ code: 'Y', kind: 'fixed', value: '100', startsAt: '2026-06-01' });
    expect((p2.startsAt as Date).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    // PromoUpdate — то же поведение.
    const u = PromoUpdateSchema.parse({ id: UUID, endsAt: '2026-06-30' });
    expect((u.endsAt as Date).toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('bogo pay_qty ≥ buy_qty отклоняется', () => {
    expect(
      PromoCreateSchema.safeParse({
        code: 'X',
        kind: 'bogo',
        bogoBuyQty: 2,
        bogoPayQty: 2,
      }).success,
    ).toBe(false);
    expect(
      PromoCreateSchema.safeParse({
        code: '3FOR2',
        kind: 'bogo',
        bogoBuyQty: 3,
        bogoPayQty: 2,
      }).success,
    ).toBe(true);
  });

  it('PromoUpdateSchema требует id и допускает частичное обновление', () => {
    expect(PromoUpdateSchema.safeParse({ id: UUID, isActive: false }).success).toBe(true);
    expect(PromoUpdateSchema.safeParse({ isActive: false }).success).toBe(false);
  });

  it('дефолты PromoCreateSchema: value=0, minOrderTotal=0, isActive=true', () => {
    const parsed = PromoCreateSchema.parse({ code: 'FD', kind: 'free_delivery' });
    expect(parsed.value).toBe('0');
    expect(parsed.minOrderTotal).toBe('0');
    expect(parsed.isActive).toBe(true);
    expect(parsed.comment).toBe('');
  });
});

describe('orders/schemas — N×M промо-механики (Пакет 5.P-1)', () => {
  it('kind=bogo без пары bogoBuyQty/bogoPayQty отклоняется', () => {
    expect(PromoCreateSchema.safeParse({ code: 'B', kind: 'bogo' }).success).toBe(false);
    expect(
      PromoCreateSchema.safeParse({ code: 'B', kind: 'bogo', bogoBuyQty: 3 }).success,
    ).toBe(false);
  });

  it('новые поля по умолчанию: applyScope=cart, priority=100, stackable=false', () => {
    const parsed = PromoCreateSchema.parse({ code: 'P', kind: 'fixed', value: '100' });
    expect(parsed.applyScope).toBe('cart');
    expect(parsed.priority).toBe(100);
    expect(parsed.stackable).toBe(false);
  });

  it('applyScope=category без targets отклоняется', () => {
    expect(
      PromoCreateSchema.safeParse({
        code: 'CAT',
        kind: 'percent',
        value: '10',
        applyScope: 'category',
      }).success,
    ).toBe(false);
  });

  it('applyScope=category с непустым targets принимается', () => {
    expect(
      PromoCreateSchema.safeParse({
        code: 'CAT',
        kind: 'percent',
        value: '10',
        applyScope: 'category',
        targets: [{ targetType: 'category', categoryId: UUID }],
      }).success,
    ).toBe(true);
  });

  it('applyScope=cart не требует targets', () => {
    expect(
      PromoCreateSchema.safeParse({
        code: 'CART',
        kind: 'percent',
        value: '10',
        applyScope: 'cart',
      }).success,
    ).toBe(true);
  });

  it('target без идентификатора нужного типа отклоняется', () => {
    expect(
      PromoCreateSchema.safeParse({
        code: 'CAT',
        kind: 'percent',
        value: '10',
        applyScope: 'category',
        targets: [{ targetType: 'category' }],
      }).success,
    ).toBe(false);
  });

  it('priority ≥ 0, minQty ≥ 1 (если задано)', () => {
    expect(
      PromoCreateSchema.safeParse({ code: 'X', kind: 'fixed', value: '1', priority: -1 })
        .success,
    ).toBe(false);
    expect(
      PromoCreateSchema.safeParse({ code: 'X', kind: 'fixed', value: '1', minQty: 0 })
        .success,
    ).toBe(false);
    expect(
      PromoCreateSchema.safeParse({ code: 'X', kind: 'fixed', value: '1', minQty: 2 })
        .success,
    ).toBe(true);
  });
});

describe('orders/schemas — free_delivery + scope (баг #10)', () => {
  // free_delivery влияет ТОЛЬКО на доставку, а доставка считается по всей корзине,
  // а не по подмножеству товаров. Привязать «бесплатную доставку» к категории/
  // бренду/набору нельзя без понятной семантики — поэтому такой промокод запрещён
  // на этапе валидации (его просто нельзя создать). См. refinePromo.
  it('free_delivery + applyScope=category отклоняется (даже с targets)', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'FDCAT',
      kind: 'free_delivery',
      applyScope: 'category',
      targets: [{ targetType: 'category', categoryId: UUID }],
    });
    expect(res.success).toBe(false);
  });

  it('free_delivery + applyScope=brand отклоняется', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'FDBRAND',
      kind: 'free_delivery',
      applyScope: 'brand',
      targets: [{ targetType: 'brand', brandId: UUID }],
    });
    expect(res.success).toBe(false);
  });

  it('free_delivery + applyScope=set отклоняется', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'FDSET',
      kind: 'free_delivery',
      applyScope: 'set',
      targets: [{ targetType: 'product', productId: UUID }],
    });
    expect(res.success).toBe(false);
  });

  it('free_delivery + applyScope=cart остаётся валидным', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'FDCART',
      kind: 'free_delivery',
      applyScope: 'cart',
    });
    expect(res.success).toBe(true);
  });

  it('free_delivery по умолчанию (applyScope=cart) валиден', () => {
    const res = PromoCreateSchema.safeParse({ code: 'FD', kind: 'free_delivery' });
    expect(res.success).toBe(true);
  });

  it('PromoUpdateSchema: free_delivery + applyScope=brand отклоняется', () => {
    const res = PromoUpdateSchema.safeParse({
      id: UUID,
      kind: 'free_delivery',
      applyScope: 'brand',
      targets: [{ targetType: 'brand', brandId: UUID }],
    });
    expect(res.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// БАГ #32 (аудит тупиков): курьерская доставка ТРЕБУЕТ адрес при СОЗДАНИИ заказа,
// иначе заказ нельзя отгрузить. На quote адрес НЕ обязателен (только оценка).
// -----------------------------------------------------------------------------

describe('orders/schemas — курьер требует адрес при создании заказа (баг #32)', () => {
  const base = {
    items: [{ variantId: UUID, qty: 1 }],
    customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79990000000' },
    paymentMethod: 'cod' as const,
  };

  it('CreateOrderSchema: курьер БЕЗ адреса → отклоняется', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', city: 'Москва' },
    });
    expect(res.success).toBe(false);
  });

  it('CreateOrderSchema: курьер с пустым адресом (пробелы) → отклоняется', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', city: 'Москва', address: '   ' },
    });
    expect(res.success).toBe(false);
  });

  it('CreateOrderSchema: курьер с адресом → принимается', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', city: 'Москва', address: 'ул. Ленина, 1' },
    });
    expect(res.success).toBe(true);
  });

  it('CreateOrderSchema: pickup без адреса → принимается (самовывоз)', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'pickup' },
    });
    expect(res.success).toBe(true);
  });

  it('CreateOrderSchema: pvz по-прежнему требует pvzCode (без регресса)', () => {
    expect(
      CreateOrderSchema.safeParse({ ...base, delivery: { type: 'pvz', city: 'Москва' } }).success,
    ).toBe(false);
    expect(
      CreateOrderSchema.safeParse({
        ...base,
        delivery: { type: 'pvz', city: 'Москва', pvzCode: 'MSK1' },
      }).success,
    ).toBe(true);
  });

  it('ManualOrderSchema: курьер без адреса → отклоняется (та же проверка)', () => {
    const res = ManualOrderSchema.safeParse({
      ...base,
      source: 'admin',
      delivery: { type: 'courier', city: 'Москва' },
    });
    expect(res.success).toBe(false);
  });

  it('CartQuoteSchema: курьер без адреса ОСТАЁТСЯ валидным (на quote адрес не нужен)', () => {
    const res = CartQuoteSchema.safeParse({
      items: [{ variantId: UUID, qty: 1 }],
      delivery: { type: 'courier', city: 'Москва' },
    });
    expect(res.success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// БАГ #5 (аудит тупиков): область применения (scope) ДОЛЖНА ограничивать тип
// таргета — иначе «Категория/Бренд» вели себя одинаково (any-target).
// -----------------------------------------------------------------------------

describe('orders/schemas — allowedTargetTypesForScope (баг #5)', () => {
  it('cart → таргеты не нужны (пустой список типов)', () => {
    expect(allowedTargetTypesForScope('cart')).toEqual([]);
  });
  it('category → только category', () => {
    expect(allowedTargetTypesForScope('category')).toEqual(['category']);
  });
  it('brand → только brand', () => {
    expect(allowedTargetTypesForScope('brand')).toEqual(['brand']);
  });
  it('set → произвольный набор всех типов', () => {
    expect([...allowedTargetTypesForScope('set')].sort()).toEqual(
      ['brand', 'category', 'product', 'variant'].sort(),
    );
  });
});

describe('orders/schemas — scope ↔ тип таргета связаны (баг #5)', () => {
  it('scope=category с таргетом-БРЕНДОМ → отклоняется', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'CATB',
      kind: 'percent',
      value: '10',
      applyScope: 'category',
      targets: [{ targetType: 'brand', brandId: UUID }],
    });
    expect(res.success).toBe(false);
  });

  it('scope=brand с таргетом-КАТЕГОРИЕЙ → отклоняется', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'BRC',
      kind: 'percent',
      value: '10',
      applyScope: 'brand',
      targets: [{ targetType: 'category', categoryId: UUID }],
    });
    expect(res.success).toBe(false);
  });

  it('scope=category с таргетом-категорией → принимается', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'CATC',
      kind: 'percent',
      value: '10',
      applyScope: 'category',
      targets: [{ targetType: 'category', categoryId: UUID }],
    });
    expect(res.success).toBe(true);
  });

  it('scope=set допускает смешанные типы таргетов (товар + бренд)', () => {
    const res = PromoCreateSchema.safeParse({
      code: 'SETMIX',
      kind: 'percent',
      value: '10',
      applyScope: 'set',
      targets: [
        { targetType: 'product', productId: UUID },
        { targetType: 'brand', brandId: UUID },
      ],
    });
    expect(res.success).toBe(true);
  });
});
