import { describe, it, expect, vi } from 'vitest';
import { PaykeeperManager } from '@/lib/payments/paykeeper/manager';
import { getPaykeeperConfig } from '@/lib/payments/paykeeper/config';
import { PaykeeperError } from '@/lib/payments/paykeeper/errors';

/**
 * Юнит-тесты фасада PaykeeperManager (docs/24 §2). isMock — единственный флаг
 * выбора mock-vs-real; client в mock НЕ инстанцируется (кидает PaykeeperError).
 */

const MOCK_CFG = getPaykeeperConfig({ NODE_ENV: 'test' });
const LIVE_CFG = getPaykeeperConfig({
  NODE_ENV: 'test',
  PAYKEEPER_LOGIN: 'l',
  PAYKEEPER_PASSWORD: 'p',
});

describe('paykeeper/manager', () => {
  it('isMock=true при пустых ключах, mock-слой доступен', () => {
    const m = new PaykeeperManager({ config: MOCK_CFG });
    expect(m.isMock).toBe(true);
    expect(typeof m.mock.mockCreateInvoice).toBe('function');
  });

  it('обращение к client в mock-режиме кидает PaykeeperError', () => {
    const m = new PaykeeperManager({ config: MOCK_CFG });
    expect(() => m.client).toThrow(PaykeeperError);
  });

  it('isMock=false при боевых ключах, client инстанцируется (ленивый синглтон)', () => {
    const m = new PaykeeperManager({ config: LIVE_CFG, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(m.isMock).toBe(false);
    expect(m.client).toBe(m.client); // один и тот же экземпляр
  });
});
