import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword, verifyDummy } from '@/lib/customer-auth/password';

/**
 * ЮНИТ — хеширование пароля покупателя (docs/24 §6). Реэкспорт argon2id из admin-
 * контура: PHC-хеш верифицируется, verifyDummy всегда false (timing-щит).
 */
describe('customer-auth/password', () => {
  it('hashPassword → PHC argon2id, verifyPassword подтверждает верный пароль', async () => {
    const hash = await hashPassword('correcthorsebatterystaple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correcthorsebatterystaple')).toBe(true);
  });

  it('verifyPassword отклоняет неверный пароль', async () => {
    const hash = await hashPassword('rightpass1');
    expect(await verifyPassword(hash, 'wrongpass1')).toBe(false);
  });

  it('verifyPassword не бросает на битом хеше → false', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('verifyDummy всегда false (и не бросает)', async () => {
    expect(await verifyDummy('anything')).toBe(false);
  });
});
