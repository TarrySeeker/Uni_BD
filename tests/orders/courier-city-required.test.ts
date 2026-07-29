import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CartQuoteSchema, CreateOrderSchema, ManualOrderSchema } from '@/lib/orders/schemas';

/**
 * АУДИТ major №3 (+ остаток №18): «Курьерская доставка БЕЗ ГОРОДА считалась
 * бесплатной и заказ уходил в производство без города».
 *
 * ЦЕПОЧКА ДЕФЕКТА (как было):
 *   1. Витрина: deliveryReady для курьера = Boolean(address.trim()) — города НЕ
 *      требовала, кнопка «Оплатить» активна с пустым городом.
 *   2. Схема: delivery.city — .optional(), refineCourierAddress требовал ТОЛЬКО
 *      адрес → тело без города проходило валидацию.
 *   3. Расчёт: hasDestination() при пустом городе → false → needsCdekProvider
 *      false → stub-провайдер отдавал { cost:'0.00', resolved:TRUE }.
 *   4. resolved:true снимал анти-андерчардж-защиту (она смотрит на resolved:false)
 *      → заказ создавался с delivery_total 0.00, магазин вёз бесплатно, а крон
 *      cdek/create-pending не мог создать накладную (нет города) — заказ повисал.
 *
 * КОРЕНЬ — п.3: «не смогли посчитать» маскировалось под «посчитали, бесплатно».
 * Поэтому фикс закрыт на трёх уровнях, и здесь проверяются все три.
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ: «город обязателен» — НЕ глобальное правило платформы.
 * Он обязателен ровно там, где без него доставка физически не считается:
 * СДЭК-курьер/ПВЗ. Зональная доставка (zoneId — цена из настроек магазина) и
 * самовывоз (pickup) города не требуют и обязаны продолжать работать, в т.ч.
 * бесплатно (порог freeThreshold применяется поверх — pricing).
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const ROOT = resolve(__dirname, '../..');
const src = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

// -----------------------------------------------------------------------------
// 1) СЕРВЕРНАЯ СХЕМА — главный рубеж (клиент не защита).
// -----------------------------------------------------------------------------

describe('№3 схема: СДЭК-курьер требует ГОРОД при создании заказа', () => {
  const base = {
    items: [{ variantId: UUID, qty: 1 }],
    customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79990000000' },
    paymentMethod: 'cod' as const,
  };

  it('курьер с адресом, но БЕЗ города → отклоняется', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', address: 'ул. Ленина, 1' },
    });
    expect(res.success).toBe(false);
  });

  it('курьер с городом из пробелов → отклоняется (trim)', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', city: '   ', address: 'ул. Ленина, 1' },
    });
    expect(res.success).toBe(false);
  });

  it('ошибка указывает на поле delivery.city (форма подсветит нужный инпут)', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', address: 'ул. Ленина, 1' },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'delivery.city')).toBe(true);
    }
  });

  it('курьер с городом И адресом → принимается (легальный кейс не сломан)', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', city: 'Москва', address: 'ул. Ленина, 1' },
    });
    expect(res.success).toBe(true);
  });

  it('числовой cityCode без строкового city → принимается (код города СДЭК точнее имени)', () => {
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', cityCode: 44, address: 'ул. Ленина, 1' },
    });
    expect(res.success).toBe(true);
  });

  it('ЗОНАЛЬНЫЙ курьер (zoneId) БЕЗ города → принимается (мультитенантность)', () => {
    // Зона — цена из настроек магазина, СДЭК не зовётся, город не нужен.
    const res = CreateOrderSchema.safeParse({
      ...base,
      delivery: { type: 'courier', zoneId: 'mkad_in', address: 'ул. Ленина, 1' },
    });
    expect(res.success).toBe(true);
  });

  it('pickup без города → принимается (самовывоз)', () => {
    expect(CreateOrderSchema.safeParse({ ...base, delivery: { type: 'pickup' } }).success).toBe(
      true,
    );
  });

  it('ПВЗ требует город (пункт выдачи без города не отгрузить)', () => {
    expect(
      CreateOrderSchema.safeParse({
        ...base,
        delivery: { type: 'pvz', pvzCode: 'MSK1' },
      }).success,
    ).toBe(false);
    expect(
      CreateOrderSchema.safeParse({
        ...base,
        delivery: { type: 'pvz', city: 'Москва', pvzCode: 'MSK1' },
      }).success,
    ).toBe(true);
  });

  it('ManualOrderSchema (ручной заказ админки): та же проверка города', () => {
    expect(
      ManualOrderSchema.safeParse({
        ...base,
        source: 'admin',
        delivery: { type: 'courier', address: 'ул. Ленина, 1' },
      }).success,
    ).toBe(false);
    expect(
      ManualOrderSchema.safeParse({
        ...base,
        source: 'admin',
        delivery: { type: 'courier', city: 'Москва', address: 'ул. Ленина, 1' },
      }).success,
    ).toBe(true);
  });

  it('CartQuoteSchema: курьер без города ОСТАЁТСЯ валидным (превью корзины не ломаем)', () => {
    // На quote город ещё не введён — превью обязано считаться (и покажет
    // «уточняется», потому что расчёт вернёт resolved:false, см. блок 2).
    const res = CartQuoteSchema.safeParse({
      items: [{ variantId: UUID, qty: 1 }],
      delivery: { type: 'courier' },
    });
    expect(res.success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 2) КОРЕНЬ ПРОБЛЕМЫ — stub 0.00 с resolved:true при НУЖНОМ, но невозможном расчёте.
// -----------------------------------------------------------------------------

describe('№3 корень: невозможный расчёт СДЭК НЕ выдаёт resolved:true 0.00', () => {
  const ORIG_MODULES = process.env.ADMIK_MODULES;
  const ORIG_ACCOUNT = process.env.CDEK_ACCOUNT;
  const ORIG_SECRET = process.env.CDEK_SECRET;

  async function load() {
    vi.resetModules();
    return import('@/lib/orders/delivery-cost');
  }

  beforeEach(() => {
    delete process.env.CDEK_ACCOUNT;
    delete process.env.CDEK_SECRET;
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIG_MODULES;
    if (ORIG_ACCOUNT === undefined) delete process.env.CDEK_ACCOUNT;
    else process.env.CDEK_ACCOUNT = ORIG_ACCOUNT;
    if (ORIG_SECRET === undefined) delete process.env.CDEK_SECRET;
    else process.env.CDEK_SECRET = ORIG_SECRET;
    vi.resetModules();
  });

  it('createOrder-путь: курьер + СДЭК включён + НЕТ назначения → БРОСАЕТ (а не 0.00)', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    await expect(
      computeDeliveryCost({
        deliveryType: 'courier',
        lines: [{ qty: 1, weightG: 500 }],
        destination: {},
      }),
    ).rejects.toMatchObject({ code: 'delivery_calc_failed' });
  });

  it('quote-путь (softFail): нет назначения → resolved:false, source unavailable', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost(
      { deliveryType: 'courier', lines: [{ qty: 1 }], destination: {} },
      { softFail: true },
    );
    // 🔴 Ключевое: «не смогли посчитать» больше НЕ маскируется под «бесплатно».
    expect(res.resolved).toBe(false);
    expect(res.source).toBe('unavailable');
  });

  it('ПВЗ + СДЭК включён + нет назначения → тоже НЕ бесплатно (resolved:false)', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost(
      { deliveryType: 'pvz', lines: [{ qty: 1 }], destination: {} },
      { softFail: true },
    );
    expect(res.resolved).toBe(false);
  });

  // ---- Легальные бесплатные случаи ОБЯЗАНЫ продолжать работать ----

  it('ЛЕГАЛЬНО БЕСПЛАТНО: pickup без назначения → 0.00 resolved:true', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'pickup',
      lines: [{ qty: 1 }],
      destination: {},
    });
    expect(res.cost).toBe('0.00');
    expect(res.resolved).toBe(true);
    expect(res.source).toBe('stub');
  });

  it('ЛЕГАЛЬНО БЕСПЛАТНО: модуль cdek ВЫКЛЮЧЕН → 0.00 resolved:true (магазин без СДЭК)', async () => {
    // Мультитенантность: инстанс без СДЭК возит сам и доставку не считает.
    process.env.ADMIK_MODULES = 'orders';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1 }],
      destination: {},
    });
    expect(res.cost).toBe('0.00');
    expect(res.resolved).toBe(true);
    expect(res.source).toBe('stub');
  });

  it('ЛЕГАЛЬНО: зона доставки без города → цена зоны, resolved:true, СДЭК не зовётся', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1 }],
      destination: { zoneId: 'zone_a' },
      zones: [{ id: 'zone_a', label: 'Зона A', price: 30000 }],
    });
    expect(res.source).toBe('zone');
    expect(res.cost).toBe('300.00');
    expect(res.resolved).toBe(true);
  });

  it('ЛЕГАЛЬНО: зона с ценой 0 (бесплатная зона магазина) → 0.00 resolved:true', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1 }],
      destination: { zoneId: 'free' },
      zones: [{ id: 'free', label: 'Бесплатно по городу', price: 0 }],
    });
    expect(res.cost).toBe('0.00');
    expect(res.resolved).toBe(true);
    expect(res.source).toBe('zone');
  });

  it('порог freeThreshold работает поверх: расчёт resolved → доставка может стать 0', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const { resolveDelivery } = await import('@/lib/orders/pricing');
    const cost = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1, weightG: 500 }],
      destination: { cityName: 'Москва' },
    });
    expect(cost.resolved).toBe(true);
    const above = resolveDelivery({ cost: cost.cost, freeThreshold: 5000 }, 600000, null);
    expect(above.costMinor).toBe(0);
    expect(above.free).toBe(true);
  });

  it('чистый предикат: canResolveDeliveryCost различает by-design 0 и невозможный расчёт', async () => {
    const { canResolveDeliveryCost } = await load();
    // Самовывоз — всегда посчитан (бесплатен by design).
    expect(
      canResolveDeliveryCost({ cdekEnabled: true, deliveryType: 'pickup', hasDestination: false }),
    ).toBe(true);
    // СДЭК выключен — доставка by design 0 (магазин её не считает).
    expect(
      canResolveDeliveryCost({ cdekEnabled: false, deliveryType: 'courier', hasDestination: false }),
    ).toBe(true);
    // СДЭК включён и назначение есть — считаем.
    expect(
      canResolveDeliveryCost({ cdekEnabled: true, deliveryType: 'courier', hasDestination: true }),
    ).toBe(true);
    // 🔴 СДЭК включён, доставка требует расчёта, а назначения НЕТ — посчитать нечем.
    expect(
      canResolveDeliveryCost({ cdekEnabled: true, deliveryType: 'courier', hasDestination: false }),
    ).toBe(false);
    expect(
      canResolveDeliveryCost({ cdekEnabled: true, deliveryType: 'pvz', hasDestination: false }),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 3) ВИТРИНА — кнопка неактивна + ПОНЯТНАЯ ЛОКАЛИЗОВАННАЯ причина.
// -----------------------------------------------------------------------------

describe('№3 витрина: CheckoutForm требует город для СДЭК-курьера', () => {
  const form = src('storefront/app/[lang]/cart/order/CheckoutForm.tsx');
  const ready = form.slice(
    form.indexOf('const deliveryReady = useMemo'),
    form.indexOf('// ---- Пересчёт'),
  );

  it('deliveryReady для курьера требует город, а не только адрес', () => {
    // Антипаттерн (баг): `return Boolean(address.trim());` как вся проверка курьера.
    expect(ready).not.toMatch(/return Boolean\(address\.trim\(\)\);\s*\/\/ courier/);
    expect(ready).toMatch(/courierCity|cityQuery|selectedCity/);
  });

  it('зональный режим по-прежнему НЕ требует города (мультитенантность)', () => {
    expect(ready).toMatch(/deliveryChoice === 'zone'[\s\S]{0,120}address\.trim\(\)/);
    expect(ready).not.toMatch(/if \(deliveryChoice === 'zone'\) return Boolean\(zoneId\);/);
  });

  it('покупателю показывается причина неактивной кнопки — строкой словаря', () => {
    expect(form).toMatch(/t\.deliveryNeedsCity/);
    // 🔴 Русский литерал в JSX недопустим (магазин трёхъязычный).
    expect(form).not.toMatch(/>\s*Укажите город/);
  });
});

describe('№3 витрина: подсказка переведена на все три языка', () => {
  it('deliveryNeedsCity есть в ru/en/fr и не совпадает между языками', async () => {
    const { getDictionary } = await import('../../storefront/lib/dictionaries');
    const ru = getDictionary('ru').checkout.deliveryNeedsCity;
    const en = getDictionary('en').checkout.deliveryNeedsCity;
    const fr = getDictionary('fr').checkout.deliveryNeedsCity;
    for (const s of [ru, en, fr]) {
      expect(s).toBeTruthy();
      expect(s.length).toBeGreaterThan(5);
      // Не машинный код и не сырой ключ.
      expect(s).not.toMatch(/[a-z]+_[a-z_]+/);
    }
    expect(en).not.toBe(ru);
    expect(fr).not.toBe(ru);
    // Английская/французская строки не содержат кириллицы (регресс «нет переводов»).
    expect(en).not.toMatch(/[А-Яа-яЁё]/);
    expect(fr).not.toMatch(/[А-Яа-яЁё]/);
  });
});
