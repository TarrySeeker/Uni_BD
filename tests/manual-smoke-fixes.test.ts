import { describe, it, expect } from 'vitest';

/**
 * РУЧНОЙ smoke реального поведения ключевых фиксов (по требованию владельца:
 * «всегда 2 проверки — кодом и вручную»). В отличие от юнит-тестов на моках —
 * импортирует НАСТОЯЩИЕ чистые функции и прогоняет их на конкретных входах,
 * печатая фактические значения (console.log) для ручной инспекции + ассертит.
 * БД/Next не нужны (чистая логика). Это живой прогон реального кода в dev.
 */

import { slugifyOrFallback, isValidSlug } from '@/lib/catalog/slug';
import { computeInStock } from '@/lib/storefront/dto';
import type { InventoryItem } from '@/lib/catalog/types';
import { lineTotalMinor, type PricedLine } from '@/lib/orders/pricing';
import { quantitySchema, CartQuoteSchema, PromoUpdateSchema } from '@/lib/orders/schemas';
import { redirectDueDate } from '@/lib/payments/tbank/service';
import { toMinor } from '@/lib/orders/money';
import { PromoCreateSchema } from '@/lib/orders/schemas';
import { ModuleOverridesInputSchema } from '@/lib/settings/action-factory';
import { buildDailySeries } from '@/lib/analytics/repository';
import { ALL_MODULES } from '@/lib/config/modules';

const D = new Date('2026-06-17T00:00:00Z');
function inv(quantity: number, reserved: number, variantId: string | null = null): InventoryItem {
  return { id: 'i', productId: 'p', variantId, warehouseCode: 'W', quantity, reserved, updatedAt: D };
}
function line(unitPrice: string, qty: number): PricedLine {
  return { name: 'n', sku: 's', unitPrice, compareAt: null, qty };
}

describe('РУЧНОЙ smoke: slugifyOrFallback (реальный прогон)', () => {
  it('эмодзи/иероглифы/имя/hint/suffix → всегда валидный slug', () => {
    const cases: Array<[string, string, string?]> = [
      ['Красное платье', ''],
      ['iPhone 15 Pro', ''],
      ['🎉🎉🎉', ''],
      ['日本語', ''],
      ['🎉', 'ABC-123'],
      ['🎉', '', 'abcd'],
      ['', ''],
    ];
    for (const [name, hint, suffix] of cases) {
      const out = slugifyOrFallback(name, hint, suffix);
      console.log(`slugifyOrFallback(${JSON.stringify(name)}, ${JSON.stringify(hint)}, ${JSON.stringify(suffix)}) = ${JSON.stringify(out)} | valid=${isValidSlug(out)}`);
      expect(out).not.toBe('');
      expect(isValidSlug(out)).toBe(true);
    }
    expect(slugifyOrFallback('🎉', '', 'abcd')).toBe('product-abcd');
    expect(slugifyOrFallback('🎉', 'ABC-123')).toBe('abc-123');
  });
});

describe('РУЧНОЙ smoke: computeInStock учитывает reserved (реальный прогон)', () => {
  it('доступное = quantity − reserved', () => {
    const probes: Array<[InventoryItem[], string | undefined, boolean]> = [
      [[inv(5, 5)], undefined, false],
      [[inv(5, 4)], undefined, true],
      [[inv(2, 5)], undefined, false],
      [[inv(3, 3, 'v1'), inv(3, 1, 'v2')], 'v1', false],
      [[inv(3, 3, 'v1'), inv(3, 1, 'v2')], 'v2', true],
    ];
    for (const [items, variantId, exp] of probes) {
      const got = computeInStock(items, variantId);
      console.log(`computeInStock(qty/res=${items.map((i) => `${i.quantity}/${i.reserved}`).join(',')}, variant=${variantId}) = ${got}`);
      expect(got).toBe(exp);
    }
  });
});

describe('РУЧНОЙ smoke: границы корзины + overflow (реальный прогон)', () => {
  it('quantitySchema 1..10000; lineTotalMinor нормальный и overflow', () => {
    expect(quantitySchema.safeParse(10000).success).toBe(true);
    expect(quantitySchema.safeParse(10001).success).toBe(false);
    expect(quantitySchema.safeParse(0).success).toBe(false);
    const normal = lineTotalMinor(line('199.99', 3));
    console.log(`lineTotalMinor('199.99' x3) = ${normal} коп.`);
    expect(normal).toBe(toMinor('199.99') * 3);
    // overflow: огромная цена×qty (qty проходит как число) → должно бросить.
    let threw = false;
    try {
      lineTotalMinor({ name: 'n', sku: 's', unitPrice: '90000000000000', compareAt: null, qty: 9999 });
    } catch (e) {
      threw = true;
      console.log(`lineTotalMinor overflow бросил: ${(e as Error).message.slice(0, 60)}…`);
    }
    expect(threw).toBe(true);
  });

  it('CartQuoteSchema: >200 позиций отклоняется', () => {
    const mk = (n: number) => ({ items: Array.from({ length: n }, () => ({ variantId: '11111111-1111-4111-8111-111111111111', qty: 1 })) });
    console.log(`CartQuoteSchema 200 items ok=${CartQuoteSchema.safeParse(mk(200)).success}, 201 ok=${CartQuoteSchema.safeParse(mk(201)).success}`);
    expect(CartQuoteSchema.safeParse(mk(200)).success).toBe(true);
    expect(CartQuoteSchema.safeParse(mk(201)).success).toBe(false);
  });
});

describe('РУЧНОЙ smoke: PromoUpdateSchema не подставляет дефолты (реальный прогон)', () => {
  it('частичный апдейт {id, code} → нет value/isActive/comment/priority/applyScope в распарсенном', () => {
    const parsed = PromoUpdateSchema.parse({ id: '11111111-1111-4111-8111-111111111111', code: 'X' });
    console.log('PromoUpdateSchema.parse({id,code}) keys =', Object.keys(parsed).sort().join(','));
    expect('value' in parsed).toBe(false);
    expect('isActive' in parsed).toBe(false);
    expect('applyScope' in parsed).toBe(false);
    expect('priority' in parsed).toBe(false);
    expect('comment' in parsed).toBe(false);
  });
});

describe('РУЧНОЙ smoke: RedirectDueDate формат Т-Банк (реальный прогон)', () => {
  it('YYYY-MM-DDTHH:MM:SS+03:00 без миллисекунд/Z', () => {
    const s = redirectDueDate(60, Date.UTC(2026, 5, 17, 19, 6, 40));
    console.log(`redirectDueDate(60, fixed) = ${s}`);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00$/);
    expect(s).not.toContain('Z');
    expect(s).not.toMatch(/\.\d{3}/);
  });
});

describe('РУЧНОЙ smoke: фиксы 2-й волны (реальный прогон)', () => {
  it('free_delivery допустим только при applyScope=cart (refinePromo)', () => {
    const cart = PromoCreateSchema.safeParse({ code: 'SMK-FD-CART', kind: 'free_delivery', applyScope: 'cart' });
    const cat = PromoCreateSchema.safeParse({
      code: 'SMK-FD-CAT', kind: 'free_delivery', applyScope: 'category',
      targets: [{ targetType: 'category', categoryId: '11111111-1111-4111-8111-111111111111' }],
    });
    console.log(`free_delivery+cart ok=${cart.success}; free_delivery+category ok=${cat.success}`);
    expect(cart.success).toBe(true);
    expect(cat.success).toBe(false);
  });

  it('ModuleOverridesInputSchema принимает payments и все ALL_MODULES', () => {
    const one = ModuleOverridesInputSchema.safeParse({ moduleOverrides: { payments: true } });
    const allObj = Object.fromEntries(ALL_MODULES.map((m) => [m, false]));
    const all = ModuleOverridesInputSchema.safeParse({ moduleOverrides: allObj });
    const unknown = ModuleOverridesInputSchema.safeParse({ moduleOverrides: { nope: true } });
    console.log(`overrides payments ok=${one.success}; all-modules ok=${all.success}; unknown ok=${unknown.success}`);
    expect(one.success).toBe(true);
    expect(all.success).toBe(true);
    expect(unknown.success).toBe(false); // .strict() отвергает неизвестный ключ
  });

  it('buildDailySeries сохраняет большое значение посещений (bigint, без обрезки)', () => {
    const series = buildDailySeries(new Map([['2026-06-17', 3_000_000_000]]), 3, '2026-06-17');
    const last = series[series.length - 1]!;
    console.log(`buildDailySeries last = ${JSON.stringify(last)}`);
    expect(last.count).toBe(3_000_000_000);
    expect(Number.isNaN(last.count)).toBe(false);
  });
});
