import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ЮНИТ (без БД): ГАШЕНИЕ ВЫПУЩЕННЫХ СЕРТИФИКАТОВ ПРИ ВОЗВРАТЕ (§5 плана волны).
 *
 * Деньги на предъявителя: если заказ на сертификат вернули покупателю, выданный
 * по нему код обязан перестать работать — иначе покупатель получает и деньги, и
 * действующий номинал. Симметрично releaseGiftTx (возврат ПОТРАЧЕННОГО номинала),
 * который в этом же месте уже вызывается.
 */

const { releaseSpy } = vi.hoisted(() => ({ releaseSpy: vi.fn(async () => true) }));
vi.mock('@/lib/orders/repository', () => ({ releaseReservation: releaseSpy }));

import { settleRefundEffectsTx } from '@/lib/orders/refund-settle';

/** Tagged-template-спай tx: подбирает ответ по подстроке запроса, копит тексты. */
function makeTx(opts: { status?: string; revoked?: { id: string }[] }) {
  const calls: string[] = [];
  const tx = ((strings: TemplateStringsArray, ..._args: unknown[]) => {
    const text = Array.from(strings).join('?');
    calls.push(text);
    if (text.includes('SELECT status, promo_code_id')) {
      return Promise.resolve(opts.status ? [{ status: opts.status, promo_code_id: null }] : []);
    }
    if (text.includes('UPDATE gift_certificates')) {
      return Promise.resolve(
        (opts.revoked ?? []).map((r) => ({
          id: r.id,
          code: 'XXXX-XXXX',
          initial_amount: '1000.00',
          spent_total: '0.00',
        })),
      );
    }
    return Promise.resolve([]);
  }) as unknown as { (...a: unknown[]): Promise<unknown[]>; __calls: string[] };
  tx.__calls = calls;
  return tx;
}

/** Запрос гашения = UPDATE gift_certificates ... status = 'disabled' по заказу. */
function revokeCalls(calls: string[]): string[] {
  return calls.filter((c) => c.includes('UPDATE gift_certificates') && c.includes("'disabled'"));
}

describe('settleRefundEffectsTx — гасит сертификаты, ВЫПУЩЕННЫЕ по заказу', () => {
  beforeEach(() => releaseSpy.mockClear());

  it("возврат оплаченного заказа → UPDATE gift_certificates ... status='disabled'", async () => {
    const tx = makeTx({ status: 'paid', revoked: [{ id: 'gc-1' }] });
    await settleRefundEffectsTx(tx as never, 'order-1', null);
    const revokes = revokeCalls(tx.__calls);
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toContain('issued_order_id');
  });

  it('гасим БЕЗУСЛОВНО: потраченный остаток — не блокировка возврата', async () => {
    // Политика волны: частично потраченный код всё равно гасится, менеджеру это
    // лишь предупреждение. Тест сторожит отсутствие «если потрачено — не гасим».
    const tx = makeTx({ status: 'shipped', revoked: [{ id: 'gc-2' }] });
    await settleRefundEffectsTx(tx as never, 'order-2', null);
    expect(revokeCalls(tx.__calls)).toHaveLength(1);
  });

  it('идемпотентно: заказ уже refunded → гашение не запускается повторно', async () => {
    const tx = makeTx({ status: 'refunded' });
    await settleRefundEffectsTx(tx as never, 'order-3', null);
    expect(revokeCalls(tx.__calls)).toHaveLength(0);
  });

  it('заказ без выпущенных сертификатов → запрос отработал вхолостую, без падения', async () => {
    const tx = makeTx({ status: 'paid', revoked: [] });
    await expect(settleRefundEffectsTx(tx as never, 'order-4', null)).resolves.toBeUndefined();
    expect(revokeCalls(tx.__calls)).toHaveLength(1);
  });
});
