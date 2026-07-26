import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineAction,
  type ActionDeps,
  type RequestMeta,
} from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { CreateOrderSchema } from '@/lib/orders/schemas';

/**
 * Находка аудита №33 (major): формы админки читают ошибки полей по ПОЛНОМУ пути
 * (`fe('customer.email')`, `fe('delivery.address')`, `fe('delivery.pvzCode')`), а
 * `parsed.error.flatten()` раскладывает их по ПЕРВОМУ сегменту пути ('customer',
 * 'delivery'). Итог: в форме ручного заказа ошибки полей покупателя и доставки не
 * показывались НИКОГДА — вместо точной доменной фразы («Для курьерской доставки
 * требуется адрес доставки.») оператор видел общее «Проверьте корректность полей».
 *
 * Контракт ActionResult расширяется АДДИТИВНО: fieldErrors содержит И полный
 * dotted-путь, И ключ верхнего уровня (старые формы продолжают работать).
 */

function makeUser(perms: PermissionCode[]): AuthUser {
  return {
    id: 'u-1',
    email: 'user@example.com',
    isOwner: false,
    permissions: new Set<PermissionCode>(perms),
  };
}

function makeDeps(user: AuthUser): Pick<
  ActionDeps,
  'getCurrentUser' | 'writeAudit' | 'revalidate' | 'getRequestMeta'
> {
  const meta: RequestMeta = { ip: '203.0.113.7', userAgent: 'vitest-UA' };
  return {
    getCurrentUser: vi.fn<ActionDeps['getCurrentUser']>(async () => user),
    writeAudit: vi.fn<ActionDeps['writeAudit']>(async () => {}),
    revalidate: vi.fn<ActionDeps['revalidate']>(async () => {}),
    getRequestMeta: vi.fn<ActionDeps['getRequestMeta']>(async () => meta),
  };
}

const deps = () => makeDeps(makeUser(['orders.write']));

describe('defineAction — вложенные ключи fieldErrors', () => {
  it('вложенный путь доступен по полному ключу И по верхнему уровню', async () => {
    const schema = z.object({
      customer: z.object({ email: z.string().email('Некорректный e-mail.') }),
    });
    const action = defineAction({
      permission: 'orders.write',
      input: schema,
      handler: vi.fn(async () => ({ result: 'ok' })),
      deps: deps(),
    });

    const res = await action({ customer: { email: 'нет-собаки' } });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.fieldErrors?.['customer.email']).toEqual(['Некорректный e-mail.']);
    // Обратная совместимость: ключ верхнего уровня остаётся.
    expect(res.fieldErrors?.customer).toEqual(['Некорректный e-mail.']);
  });

  it('плоский путь работает как раньше (ключ без точки)', async () => {
    const schema = z.object({ name: z.string().min(1, 'Обязательное поле.') });
    const action = defineAction({
      permission: 'orders.write',
      input: schema,
      handler: vi.fn(async () => ({ result: 'ok' })),
      deps: deps(),
    });

    const res = await action({ name: '' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.fieldErrors?.name).toEqual(['Обязательное поле.']);
  });

  it('superRefine курьерского адреса доезжает до поля delivery.address формы', async () => {
    const action = defineAction({
      permission: 'orders.write',
      input: CreateOrderSchema,
      handler: vi.fn(async () => ({ result: 'ok' })),
      deps: deps(),
    });

    const res = await action({
      items: [{ productId: '11111111-1111-4111-8111-111111111111', qty: 1 }],
      customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79990000000' },
      delivery: { type: 'courier', city: 'Москва' },
      paymentMethod: 'card',
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.fieldErrors?.['delivery.address']).toEqual([
      'Для курьерской доставки требуется адрес доставки.',
    ]);
  });

  it('обязательный код ПВЗ доезжает до поля delivery.pvzCode формы', async () => {
    const action = defineAction({
      permission: 'orders.write',
      input: CreateOrderSchema,
      handler: vi.fn(async () => ({ result: 'ok' })),
      deps: deps(),
    });

    const res = await action({
      items: [{ productId: '11111111-1111-4111-8111-111111111111', qty: 1 }],
      customer: { name: 'Иван', email: 'ivan@example.com', phone: '+79990000000' },
      delivery: { type: 'pvz', city: 'Москва' },
      paymentMethod: 'card',
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.fieldErrors?.['delivery.pvzCode']?.[0]).toMatch(/пункт/i);
  });

  it('индексы массива не теряют путь (items.0.qty)', async () => {
    const schema = z.object({
      items: z.array(z.object({ qty: z.number().int().positive('Количество > 0.') })),
    });
    const action = defineAction({
      permission: 'orders.write',
      input: schema,
      handler: vi.fn(async () => ({ result: 'ok' })),
      deps: deps(),
    });

    const res = await action({ items: [{ qty: 0 }] });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.fieldErrors?.['items.0.qty']).toEqual(['Количество > 0.']);
    expect(res.fieldErrors?.items).toEqual(['Количество > 0.']);
  });
});
