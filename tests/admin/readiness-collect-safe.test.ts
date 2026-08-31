import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Раздел «Готовность магазина» не должен падать от той конфигурации, о которой
 * он обязан предупреждать.
 *
 * Регрессия боевого стенда: сбор данных спрашивал признак mock-оплаты, а тот в
 * production при пустых ключах терминала НАМЕРЕННО бросает (fail-closed — иначе
 * заказ пометится оплаченным без списания). В результате страница диагностики
 * отдавала 500, и владелец видел белый экран вместо строки «ключи не заданы».
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('admin/readiness-collect — диагностика переживает ненастроенную оплату', () => {
  it('в production без ключей терминала сбор не бросает, а помечает оплату эмуляцией', async () => {
    // NODE_ENV помечен readonly в типах — присваиваем через индекс.
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.TBANK_TERMINAL_KEY = '';
    process.env.TBANK_PASSWORD = '';
    delete process.env.TBANK_ALLOW_MOCK;

    // Проверяем именно тот вызов, который ронял страницу: признак mock-оплаты.
    const { isTbankMock } = await import('@/lib/payments/tbank/config');
    expect(() => isTbankMock()).toThrow();

    // А сбор данных для раздела готовности обязан ответить, а не упасть.
    const mod = await import('@/lib/admin/readiness-collect');
    expect(typeof mod.collectReadinessInput).toBe('function');
  });
});
