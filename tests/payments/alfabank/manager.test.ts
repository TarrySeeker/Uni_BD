import { describe, it, expect, vi } from 'vitest';
import { AlfabankManager } from '@/lib/payments/alfabank/manager';
import { getAlfabankConfig } from '@/lib/payments/alfabank/config';
import { AlfabankError } from '@/lib/payments/alfabank/errors';

/**
 * Юнит-тесты фасада AlfabankManager. isMock — единственный флаг выбора mock-vs-real;
 * client в mock НЕ инстанцируется (кидает AlfabankError).
 */

const MOCK_CFG = getAlfabankConfig({ NODE_ENV: 'test' });
const LIVE_CFG = getAlfabankConfig({
  NODE_ENV: 'test',
  ALFABANK_USERNAME: 'u',
  ALFABANK_PASSWORD: 'p',
});

describe('alfabank/manager', () => {
  it('isMock=true при пустых ключах, mock-слой доступен', () => {
    const m = new AlfabankManager({ config: MOCK_CFG });
    expect(m.isMock).toBe(true);
    expect(typeof m.mock.mockRegisterOrder).toBe('function');
  });

  it('обращение к client в mock-режиме кидает AlfabankError', () => {
    const m = new AlfabankManager({ config: MOCK_CFG });
    expect(() => m.client).toThrow(AlfabankError);
  });

  it('isMock=false при боевых ключах, client инстанцируется (ленивый синглтон)', () => {
    const m = new AlfabankManager({ config: LIVE_CFG, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(m.isMock).toBe(false);
    expect(m.client).toBe(m.client); // один и тот же экземпляр
  });
});
