import { describe, it, expect } from 'vitest';
import { TbankManager } from '@/lib/payments/tbank/manager';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import { TbankError } from '@/lib/payments/tbank/errors';

/**
 * Юнит-тесты фасада TbankManager (docs/15 §2.1). Конфиг подаём напрямую (не из
 * process.env), чтобы тест был детерминирован и не мутировал окружение.
 */

const MOCK_CFG = getTbankConfig({ NODE_ENV: 'test' });
const REAL_CFG = getTbankConfig({
  NODE_ENV: 'test',
  TBANK_TERMINAL_KEY: 'tk',
  TBANK_PASSWORD: 'pw',
});

describe('tbank/manager — выбор mock vs real', () => {
  it('пустые ключи → isMock=true, mock-слой доступен', () => {
    const m = new TbankManager({ config: MOCK_CFG });
    expect(m.isMock).toBe(true);
    expect(typeof m.mock.mockInitPayment).toBe('function');
  });

  it('обращение к client в mock-режиме кидает TbankError (баг вызывающего)', () => {
    const m = new TbankManager({ config: MOCK_CFG });
    expect(() => m.client).toThrow(TbankError);
  });

  it('боевые ключи → isMock=false, client инстанцируется (ленивый синглтон)', () => {
    const m = new TbankManager({ config: REAL_CFG, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    expect(m.isMock).toBe(false);
    const c1 = m.client;
    const c2 = m.client;
    expect(c1).toBe(c2); // один и тот же синглтон
    expect(typeof c1.call).toBe('function');
  });
});
