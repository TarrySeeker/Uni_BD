import { describe, it, expect } from 'vitest';
import type { TransactionSql } from 'postgres';

import { revokeIssuedGiftsTx } from '@/lib/gift-certificates/repository';

/**
 * ЮНИТ — гашение выпущенных кодов при возврате заказа (ТЗ п.11).
 *
 * Возврат денег обязан обесценивать выданный код: иначе покупатель получает и
 * деньги обратно, и сертификат на ту же сумму. Проверяем контракт функции и
 * КЛЮЧЕВЫЕ guard-условия запроса (только свой заказ, только живые статусы) —
 * поведение на реальной БД доберёт интеграционный прогон координатора.
 */

interface FakeCall {
  text: string;
  values: unknown[];
}

function fakeTx(rows: Record<string, unknown>[]): { tx: TransactionSql; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    const result = rows.slice() as Record<string, unknown>[] & { count: number };
    result.count = rows.length;
    return Promise.resolve(result);
  }) as unknown as TransactionSql;
  return { tx, calls };
}

describe('revokeIssuedGiftsTx — гашение кодов, выпущенных по заказу', () => {
  it('гасит найденные коды и отдаёт их для аудита/уведомления', async () => {
    const { tx } = fakeTx([
      { id: 'c1', code: 'ABCD-EFGH-JKMN-PQRS', initial_amount: '5000.00', spent_total: '0.00' },
      { id: 'c2', code: 'WXYZ-0123-4567-89AB', initial_amount: '1000.00', spent_total: '250.00' },
    ]);
    const res = await revokeIssuedGiftsTx(tx, { orderId: 'o-1' });

    expect(res.revokedCount).toBe(2);
    expect(res.revoked[0]).toEqual({
      id: 'c1',
      code: 'ABCD-EFGH-JKMN-PQRS',
      initialAmount: '5000.00',
      spentTotal: '0.00',
    });
    expect(res.revoked[1]!.spentTotal).toBe('250.00');
  });

  it('идемпотентна: повторный вызов не находит строк → 0 без ошибки', async () => {
    const { tx } = fakeTx([]);
    const res = await revokeIssuedGiftsTx(tx, { orderId: 'o-1' });
    expect(res).toEqual({ revokedCount: 0, revoked: [] });
  });

  it('не трогает чужие заказы и живые статусы: orderId — параметр, фильтр по issued_order_id', async () => {
    const { tx, calls } = fakeTx([]);
    await revokeIssuedGiftsTx(tx, { orderId: 'o-42' });

    const q = calls[0]!;
    expect(q.values).toContain('o-42');
    expect(q.text).toMatch(/issued_order_id/);
    // Гасим только «живые» коды: disabled/expired повторно не переписываем.
    expect(q.text).toMatch(/status\s+IN\s*\(\s*'active'\s*,\s*'depleted'\s*\)/);
    expect(q.text).toMatch(/SET\s+status\s*=\s*'disabled'/);
    // Идентификатор заказа не склеен в текст запроса (анти-SQLi).
    expect(q.text).not.toContain('o-42');
  });
});
