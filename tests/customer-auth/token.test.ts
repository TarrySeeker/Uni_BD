import { describe, expect, it } from 'vitest';

import {
  generateRawToken,
  hashToken,
  safeEqualHex,
} from '@/lib/customer-auth/token';

/**
 * ЮНИТ — одноразовые токены (docs/24 §6). Сырой токен высокоэнтропийный, в БД
 * лежит sha256(raw); сырой не восстановим из хеша.
 */
describe('customer-auth/token', () => {
  it('generateRawToken: 64 hex-символа (32 байта = 256 бит), уникален', () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('hashToken: детерминирован, 64 hex (sha256), отличается от сырого', () => {
    const raw = 'deadbeef';
    const h1 = hashToken(raw);
    const h2 = hashToken(raw);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(raw);
  });

  it('hashToken: разные входы → разные хеши', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('safeEqualHex: равные хеши → true, разные → false, разной длины → false', () => {
    const h = hashToken('x');
    expect(safeEqualHex(h, h)).toBe(true);
    expect(safeEqualHex(h, hashToken('y'))).toBe(false);
    expect(safeEqualHex(h, 'ab')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});
