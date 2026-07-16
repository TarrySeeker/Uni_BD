import { describe, it, expect } from 'vitest';
import { signCallback, verifyCallbackChecksum } from '@/lib/payments/alfabank/token';

/**
 * Юнит-тесты checksum колбэка Альфа-Банка (RBS symmetric-key HMAC-SHA256). ЧИСТЫЕ.
 * checksum считается по параметрам БЕЗ самого checksum, отсортированным по имени,
 * склеенным как `name;value;`, hex В ВЕРХНЕМ регистре.
 */

const SECRET = 'hmac-secret-word';

describe('alfabank/token — signCallback', () => {
  it('HMAC-SHA256 hex ВЕРХНИЙ регистр, детерминирован', () => {
    const params = { mdOrder: 'abc', orderNumber: 'N-1', operation: 'deposited', status: '1' };
    const sig = signCallback(params, SECRET);
    expect(sig).toMatch(/^[0-9A-F]{64}$/);
    expect(signCallback(params, SECRET)).toBe(sig);
  });

  it('checksum в наборе не участвует в подписи (исключается)', () => {
    const base = { mdOrder: 'abc', orderNumber: 'N-1', operation: 'deposited', status: '1' };
    const withChecksum = { ...base, checksum: 'DEADBEEF' };
    expect(signCallback(withChecksum, SECRET)).toBe(signCallback(base, SECRET));
  });

  it('порядок ключей не влияет (сортировка по имени)', () => {
    const a = { mdOrder: 'x', orderNumber: 'y', operation: 'deposited', status: '1' };
    const b = { status: '1', operation: 'deposited', orderNumber: 'y', mdOrder: 'x' };
    expect(signCallback(a, SECRET)).toBe(signCallback(b, SECRET));
  });

  it('изменение значения меняет подпись', () => {
    const a = { mdOrder: 'x', status: '1' };
    const b = { mdOrder: 'x', status: '0' };
    expect(signCallback(a, SECRET)).not.toBe(signCallback(b, SECRET));
  });
});

describe('alfabank/token — verifyCallbackChecksum', () => {
  it('валидный checksum → true', () => {
    const params = { mdOrder: 'abc', orderNumber: 'N-1', operation: 'deposited', status: '1' };
    const checksum = signCallback(params, SECRET);
    expect(verifyCallbackChecksum({ ...params, checksum }, SECRET)).toBe(true);
  });

  it('регистронезависимо к hex checksum', () => {
    const params = { mdOrder: 'abc', status: '1' };
    const checksum = signCallback(params, SECRET).toLowerCase();
    expect(verifyCallbackChecksum({ ...params, checksum }, SECRET)).toBe(true);
  });

  it('невалидный checksum → false', () => {
    const params = { mdOrder: 'abc', status: '1' };
    expect(verifyCallbackChecksum({ ...params, checksum: 'DEADBEEF' }, SECRET)).toBe(false);
  });

  it('подделка значения (при старом checksum) → false', () => {
    const params = { mdOrder: 'abc', status: '1' };
    const checksum = signCallback(params, SECRET);
    // Атакующий меняет status на 1 → 0, но не может пересчитать checksum без secret.
    expect(verifyCallbackChecksum({ ...params, status: '0', checksum }, SECRET)).toBe(false);
  });

  it('пустой checksum / пустой secret → false', () => {
    const params = { mdOrder: 'abc', status: '1', checksum: '' };
    expect(verifyCallbackChecksum(params, SECRET)).toBe(false);
    expect(verifyCallbackChecksum({ ...params, checksum: 'X' }, '')).toBe(false);
  });
});
