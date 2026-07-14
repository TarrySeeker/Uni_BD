import { describe, expect, it } from 'vitest';

import { generateCustomerSessionId } from '@/lib/customer-auth/session';

/**
 * ЮНИТ — генератор id сессии покупателя (docs/24 §6). 160 бит энтропии → base32,
 * 32 символа безопасного алфавита; высокая уникальность.
 */
describe('customer-auth/session — generateCustomerSessionId', () => {
  it('32 символа из base32-алфавита (a-z2-7)', () => {
    const id = generateCustomerSessionId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-z2-7]{32}$/);
  });

  it('уникален на большой выборке (нет коллизий)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 5000; i++) set.add(generateCustomerSessionId());
    expect(set.size).toBe(5000);
  });
});
