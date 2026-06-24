import { beforeEach, describe, expect, it, vi } from 'vitest';

// releaseReservation мокаем — проверяем, что сетл его дёргает по позициям.
// vi.hoisted: фабрика vi.mock поднимается выше объявлений → spy нужен hoisted.
const { releaseSpy } = vi.hoisted(() => ({ releaseSpy: vi.fn(async () => true) }));
vi.mock('@/lib/orders/repository', () => ({ releaseReservation: releaseSpy }));

import { settleRefundEffectsTx } from '@/lib/orders/refund-settle';

/** Tagged-template-спай tx: подбирает ответ по подстроке запроса, копит тексты. */
function makeTx(opts: {
  status?: string;
  promo?: string | null;
  items?: { product_id: string | null; variant_id: string | null; quantity: number }[];
  deleted?: { id: string }[];
}) {
  const calls: string[] = [];
  const tx = ((strings: TemplateStringsArray, ..._args: unknown[]) => {
    const text = Array.from(strings).join('?');
    calls.push(text);
    if (text.includes('SELECT status, promo_code_id')) {
      return Promise.resolve(
        opts.status ? [{ status: opts.status, promo_code_id: opts.promo ?? null }] : [],
      );
    }
    if (text.includes('FROM order_items')) return Promise.resolve(opts.items ?? []);
    if (text.includes('DELETE FROM promo_redemptions')) return Promise.resolve(opts.deleted ?? []);
    return Promise.resolve([]);
  }) as unknown as { (...a: unknown[]): Promise<unknown[]>; __calls: string[] };
  tx.__calls = calls;
  return tx;
}

describe('settleRefundEffectsTx — сетл возврата заказа (БАГ #3/#4, аудит волны 15)', () => {
  beforeEach(() => releaseSpy.mockClear());

  it("paid + промокод + позиция → release резерва, откат промо, order.status='refunded'", async () => {
    const tx = makeTx({
      status: 'paid',
      promo: 'promo-1',
      items: [{ product_id: 'p1', variant_id: 'v1', quantity: 2 }],
      deleted: [{ id: 'r1' }],
    });
    await settleRefundEffectsTx(tx as never, 'order-1', null);
    expect(releaseSpy).toHaveBeenCalledWith(tx, { productId: 'p1', variantId: 'v1', qty: 2 });
    const calls = tx.__calls.join('||');
    expect(calls).toContain('DELETE FROM promo_redemptions');
    expect(calls).toContain('UPDATE promo_codes'); // декремент used_count
    expect(calls).toMatch(/UPDATE orders\s+SET status = 'refunded'/);
  });

  it('идемпотентно: order уже refunded → no-op (нет release/UPDATE статуса)', async () => {
    const tx = makeTx({ status: 'refunded', promo: 'promo-1' });
    await settleRefundEffectsTx(tx as never, 'order-1', null);
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(tx.__calls.join('||')).not.toContain('UPDATE orders');
  });

  it('shipped → резерв НЕ освобождается (уже списан commit-ом), но статус сеттлится', async () => {
    const tx = makeTx({ status: 'shipped', promo: null });
    await settleRefundEffectsTx(tx as never, 'order-1', null);
    expect(releaseSpy).not.toHaveBeenCalled(); // shipped вне RESERVE_HELD → не трогаем (anti-oversell)
    expect(tx.__calls.join('||')).toMatch(/UPDATE orders\s+SET status = 'refunded'/);
  });

  it('заказ не найден → no-op', async () => {
    const tx = makeTx({});
    await settleRefundEffectsTx(tx as never, 'missing', null);
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(tx.__calls.join('||')).not.toContain('UPDATE orders');
  });
});
