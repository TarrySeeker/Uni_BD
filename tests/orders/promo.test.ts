import { describe, expect, it } from 'vitest';

import { validatePromo } from '@/lib/orders/promo';
import type { PromoCode } from '@/lib/orders/types';

/**
 * Валидация промокода (docs/07 §3.4) — чистая функция, лимиты через переданные
 * счётчики. Всегда зелёные (БД не нужна).
 */

function makePromo(over: Partial<PromoCode> = {}): PromoCode {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    code: over.code ?? 'SALE',
    kind: over.kind ?? 'percent',
    value: over.value ?? '10',
    minOrderTotal: over.minOrderTotal ?? '0',
    maxDiscount: over.maxDiscount ?? null,
    usageLimit: over.usageLimit ?? null,
    perCustomerLimit: over.perCustomerLimit ?? null,
    usedCount: over.usedCount ?? 0,
    startsAt: over.startsAt ?? null,
    endsAt: over.endsAt ?? null,
    isActive: over.isActive ?? true,
    bogoBuyQty: over.bogoBuyQty ?? null,
    bogoPayQty: over.bogoPayQty ?? null,
    applyScope: over.applyScope ?? 'cart',
    priority: over.priority ?? 100,
    stackable: over.stackable ?? false,
    minQty: over.minQty ?? null,
    giftProductId: over.giftProductId ?? null,
    giftVariantId: over.giftVariantId ?? null,
    giftQty: over.giftQty ?? null,
    comment: over.comment ?? '',
    createdAt: over.createdAt ?? new Date('2026-01-01'),
    updatedAt: over.updatedAt ?? new Date('2026-01-01'),
  };
}

const NOW = new Date('2026-06-15T12:00:00Z');

describe('promo/validatePromo — успех', () => {
  it('активный промокод без условий → valid + AppliedPromo', () => {
    const res = validatePromo(makePromo(), { itemsTotal: '1000.00', now: NOW });
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.promo.code).toBe('SALE');
      expect(res.promo.kind).toBe('percent');
      expect(res.promo.value).toBe('10');
    }
  });

  it('сумма ровно равна минимальной → valid', () => {
    const res = validatePromo(makePromo({ minOrderTotal: '1000.00' }), {
      itemsTotal: '1000.00',
      now: NOW,
    });
    expect(res.valid).toBe(true);
  });

  it('в пределах срока действия → valid', () => {
    const res = validatePromo(
      makePromo({
        startsAt: new Date('2026-06-01'),
        endsAt: new Date('2026-06-30'),
      }),
      { itemsTotal: '500.00', now: NOW },
    );
    expect(res.valid).toBe(true);
  });
});

describe('promo/validatePromo — отказы', () => {
  it('неактивен', () => {
    const res = validatePromo(makePromo({ isActive: false }), { itemsTotal: '1000.00', now: NOW });
    expect(res).toMatchObject({ valid: false, reason: 'inactive' });
  });

  it('ещё не начался', () => {
    const res = validatePromo(makePromo({ startsAt: new Date('2026-07-01') }), {
      itemsTotal: '1000.00',
      now: NOW,
    });
    expect(res).toMatchObject({ valid: false, reason: 'not_started' });
  });

  it('просрочен', () => {
    const res = validatePromo(makePromo({ endsAt: new Date('2026-06-01') }), {
      itemsTotal: '1000.00',
      now: NOW,
    });
    expect(res).toMatchObject({ valid: false, reason: 'expired' });
  });

  it('ниже минимальной суммы', () => {
    const res = validatePromo(makePromo({ minOrderTotal: '2000.00' }), {
      itemsTotal: '1999.99',
      now: NOW,
    });
    expect(res).toMatchObject({ valid: false, reason: 'below_min_total' });
  });

  it('превышен общий лимит (через переданный usedCount)', () => {
    const res = validatePromo(makePromo({ usageLimit: 100 }), {
      itemsTotal: '1000.00',
      now: NOW,
      usedCount: 100,
    });
    expect(res).toMatchObject({ valid: false, reason: 'usage_limit_reached' });
  });

  it('общий лимит ещё не исчерпан → valid', () => {
    const res = validatePromo(makePromo({ usageLimit: 100 }), {
      itemsTotal: '1000.00',
      now: NOW,
      usedCount: 99,
    });
    expect(res.valid).toBe(true);
  });

  it('превышен лимит на покупателя (через переданный customerRedemptions)', () => {
    const res = validatePromo(makePromo({ perCustomerLimit: 1 }), {
      itemsTotal: '1000.00',
      now: NOW,
      customerRedemptions: 1,
    });
    expect(res).toMatchObject({ valid: false, reason: 'per_customer_limit_reached' });
  });

  it('лимит на покупателя ещё не достигнут → valid', () => {
    const res = validatePromo(makePromo({ perCustomerLimit: 2 }), {
      itemsTotal: '1000.00',
      now: NOW,
      customerRedemptions: 1,
    });
    expect(res.valid).toBe(true);
  });
});

describe('promo/validatePromo — типы скидок проходят валидацию', () => {
  for (const kind of ['percent', 'fixed', 'free_delivery'] as const) {
    it(`kind=${kind} → valid`, () => {
      const res = validatePromo(makePromo({ kind, value: kind === 'percent' ? '10' : '100' }), {
        itemsTotal: '1000.00',
        now: NOW,
      });
      expect(res.valid).toBe(true);
      if (res.valid) expect(res.promo.kind).toBe(kind);
    });
  }

  it('bogo с корректной парой → valid', () => {
    const res = validatePromo(makePromo({ kind: 'bogo', bogoBuyQty: 3, bogoPayQty: 2 }), {
      itemsTotal: '1000.00',
      now: NOW,
    });
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.promo.kind).toBe('bogo');
  });
});

describe('promo/validatePromo — N×M (Пакет 5.P-1)', () => {
  it('bogo без пары bogoBuyQty/bogoPayQty → отказ invalid_kind', () => {
    const res = validatePromo(makePromo({ kind: 'bogo', bogoBuyQty: null, bogoPayQty: null }), {
      itemsTotal: '1000.00',
      now: NOW,
    });
    expect(res).toMatchObject({ valid: false, reason: 'invalid_kind' });
  });

  it('min_qty не достигнут (itemsQty < minQty) → below_min_qty (про количество, не про сумму)', () => {
    const res = validatePromo(makePromo({ minQty: 3 }), {
      itemsTotal: '1000.00',
      itemsQty: 2,
      now: NOW,
    });
    // Баг #6 аудита тупиков: причина — НЕДОСТАТОК ЕДИНИЦ, а не суммы. Отдельный
    // reason 'below_min_qty', а сообщение говорит про количество, не про сумму.
    expect(res).toMatchObject({ valid: false, reason: 'below_min_qty' });
    if (!res.valid) {
      expect(res.message).not.toBe('Сумма заказа меньше минимальной для этого промокода.');
      expect(res.message.toLowerCase()).toMatch(/единиц|количеств/);
    }
  });

  it('недостаток суммы по-прежнему отдаёт below_min_total (про сумму)', () => {
    const res = validatePromo(makePromo({ minOrderTotal: '2000.00' }), {
      itemsTotal: '1000.00',
      itemsQty: 10,
      now: NOW,
    });
    expect(res).toMatchObject({ valid: false, reason: 'below_min_total' });
    if (!res.valid) {
      expect(res.message.toLowerCase()).toMatch(/сумм/);
    }
  });

  it('min_qty достигнут → valid', () => {
    const res = validatePromo(makePromo({ minQty: 3 }), {
      itemsTotal: '1000.00',
      itemsQty: 3,
      now: NOW,
    });
    expect(res.valid).toBe(true);
  });
});
