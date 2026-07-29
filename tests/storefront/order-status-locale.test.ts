import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { toOrderPublicDto } from '@/lib/storefront/order-dto';
import { toCustomerOrderDto } from '@/lib/storefront/account-dto';
import type { Order, OrderItem } from '@/lib/orders/types';

/**
 * Аудит major №5/№30, minor №6: покупатель на /en и /fr видел РУССКИЕ подписи
 * статусов — сервер отдавал их сырьём, а роут выбрасывал уже вычисленную локаль.
 *
 * 🔴 КОНТРАКТ НЕ ЛОМАЕМ. Поля statusLabel/paymentStatusLabel/deliveryStatusLabel
 * потребляет ЖИВАЯ витрина (erfgv.website) — они обязаны остаться на месте и
 * содержать ТЕКСТ (не ключ). Меняется только язык этого текста: язык ПОКУПАТЕЛЯ.
 */

const CYRILLIC = /[А-Яа-яЁё]/;

function order(over: Partial<Order> = {}): Order {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    number: 'TST-2026-000001',
    status: 'shipped',
    paymentStatus: 'paid',
    deliveryStatus: 'in_transit',
    itemsTotal: '100.00',
    discountTotal: '0.00',
    giftDiscountTotal: '0.00',
    deliveryTotal: '0.00',
    grandTotal: '100.00',
    currency: 'RUB',
    promoCode: null,
    paymentMethod: 'card',
    paymentInitiatedAt: null,
    deliveryType: 'courier',
    isPostamat: false,
    deliveryCity: 'Москва',
    deliveryZoneId: null,
    deliveryZoneLabel: null,
    deliveryAddress: null,
    deliveryPvzCode: null,
    cdekTrack: null,
    customerEmail: 'buyer@example.com',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...(over as Record<string, unknown>),
  } as unknown as Order;
}

const items: OrderItem[] = [];

describe('order-dto — подпись статуса на языке ПОКУПАТЕЛЯ (major №5, №30)', () => {
  it('без локали — прежнее русское поведение (обратная совместимость)', () => {
    const dto = toOrderPublicDto(order(), items);
    expect(dto.statusLabel).toBe('Отгружен');
    expect(dto.paymentStatusLabel).toBe('Оплачена');
    expect(dto.deliveryStatusLabel).toBe('В пути');
  });

  it('locale=en → английские подписи, без кириллицы', () => {
    const dto = toOrderPublicDto(order(), items, { locale: 'en' });
    expect(dto.statusLabel).toBe('Shipped');
    expect(dto.paymentStatusLabel).toBe('Paid');
    expect(dto.deliveryStatusLabel).toBe('In transit');
    for (const v of [dto.statusLabel, dto.paymentStatusLabel, dto.deliveryStatusLabel]) {
      expect(CYRILLIC.test(v)).toBe(false);
    }
  });

  it('locale=fr → французские подписи, без кириллицы', () => {
    const dto = toOrderPublicDto(order(), items, { locale: 'fr' });
    for (const v of [dto.statusLabel, dto.paymentStatusLabel, dto.deliveryStatusLabel]) {
      expect(v).toBeTruthy();
      expect(CYRILLIC.test(v)).toBe(false);
    }
    expect(dto.deliveryStatusLabel).toBe('En cours de livraison');
  });

  it('🔴 поля остались ТЕКСТОМ, а не ключом каталога (живая витрина печатает как есть)', () => {
    for (const locale of ['ru', 'en', 'fr'] as const) {
      const dto = toOrderPublicDto(order(), items, { locale });
      for (const v of [dto.statusLabel, dto.paymentStatusLabel, dto.deliveryStatusLabel]) {
        expect(v, `${locale}: похоже на ключ`).not.toMatch(/^orders\./);
        expect(v).not.toContain('statusLabels');
      }
    }
  });

  it('🔴 форма DTO не изменилась: все три поля на месте при любой локали', () => {
    const dto = toOrderPublicDto(order(), items, { locale: 'en' });
    expect(Object.keys(dto)).toEqual(expect.arrayContaining([
      'statusLabel', 'paymentStatusLabel', 'deliveryStatusLabel',
      'status', 'paymentStatus', 'deliveryStatus',
    ]));
    // Машиночитаемые коды не тронуты — витрина резолвит по ним свой словарь.
    expect(dto.status).toBe('shipped');
    expect(dto.paymentStatus).toBe('paid');
    expect(dto.deliveryStatus).toBe('in_transit');
  });

  it('локаль не влияет на чувствительные поля доставки (защита не ослаблена)', () => {
    const o = order({ deliveryAddress: 'ул. Тайная, 1', deliveryPvzCode: 'MSK1' } as Partial<Order>);
    const weak = toOrderPublicDto(o, items, { locale: 'en' });
    expect(weak.delivery.address).toBeNull();
    expect(weak.delivery.pvzCode).toBeNull();
    const strong = toOrderPublicDto(o, items, {
      locale: 'en',
      includeSensitiveDelivery: true,
    });
    expect(strong.delivery.address).toBe('ул. Тайная, 1');
  });
});

describe('account-dto — история заказов в ЛК на языке покупателя (minor №6)', () => {
  const summary = {
    number: 'TST-2026-000002',
    status: 'shipped',
    paymentStatus: 'paid',
    deliveryStatus: 'in_transit',
    grandTotal: '100.00',
    currency: 'RUB',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  } as Parameters<typeof toCustomerOrderDto>[0];

  it('без локали — прежние русские подписи', () => {
    const dto = toCustomerOrderDto(summary);
    expect(dto.statusLabel).toBe('Отгружен');
  });

  it('locale=en/fr → локализованные подписи без кириллицы', () => {
    for (const locale of ['en', 'fr'] as const) {
      const dto = toCustomerOrderDto(summary, locale);
      for (const v of [dto.statusLabel, dto.paymentStatusLabel, dto.deliveryStatusLabel]) {
        expect(v, locale).toBeTruthy();
        expect(CYRILLIC.test(v), `${locale}: кириллица`).toBe(false);
      }
      expect(dto.status, 'машинный код не тронут').toBe('shipped');
    }
  });
});

// ---------------------------------------------------------------------------
// Guard по исходнику роутов: локаль обязана ДОЙТИ до маппера.
// Именно её потеря и была дефектом — runStorefront её вычислял, а роут
// деструктурировал только { cors } и молча выбрасывал.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('🔴 роуты не выбрасывают вычисленную локаль покупателя', () => {
  it('GET /orders/:number прокидывает locale в toOrderPublicDto', () => {
    const src = read('app/api/storefront/v1/orders/[number]/route.ts');
    expect(src, 'локаль не извлекается из контекста').toMatch(
      /async\s*\(\s*\{[^}]*\blocale\b[^}]*\}\s*\)/,
    );
    expect(src, 'локаль не передана в маппер').toMatch(/toOrderPublicDto\([\s\S]{0,240}locale/);
  });

  it('GET /account/orders прокидывает locale в toCustomerOrderDto', () => {
    const src = read('app/api/storefront/v1/account/orders/route.ts');
    expect(src).toMatch(/async\s*\(\s*\{[^}]*\blocale\b[^}]*\}\s*\)/);
    expect(src).toMatch(/toCustomerOrderDto\([^)]*locale/);
  });
});
