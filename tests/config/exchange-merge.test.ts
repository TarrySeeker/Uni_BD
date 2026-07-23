import { describe, it, expect } from 'vitest';

import { mergeSettings } from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';

/**
 * Мультивалюта отображения в эффективных настройках (env ⊕ БД).
 * Базовая валюта (RUB) — из currency.code; доп.валюты (€) — из ключа exchange.
 * Анти-регресс: без exchange эффективные настройки содержат пустой список доп.валют.
 */

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({ NODE_ENV: 'test', SHOP_CURRENCY: 'RUB', ...overrides });
}

describe('config/settings — exchange merge', () => {
  it('нет строки exchange → displayCurrencies пуст, autoRate=false (анти-регресс)', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.exchange.displayCurrencies).toEqual([]);
    expect(eff.exchange.autoRate).toBe(false);
    expect(eff.exchange.rateUpdatedAt).toBeNull();
    // Базовая валюта не тронута.
    expect(eff.currency.code).toBe('RUB');
  });

  it('строка exchange с EUR → доп.валюта отображения с курсом и знаками', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'exchange',
        value: {
          autoRate: true,
          rateUpdatedAt: '2026-07-16T10:00:00.000Z',
          displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 100.5, fractionDigits: 2 }],
        },
      },
    ]);
    expect(eff.exchange.autoRate).toBe(true);
    expect(eff.exchange.rateUpdatedAt).toBe('2026-07-16T10:00:00.000Z');
    // manualRate/rateUpdatedAt — пер-валютные признаки: в значении их нет →
    // добиваются дефолтами (валюта на автокурсе, отдельной метки нет).
    expect(eff.exchange.displayCurrencies).toEqual([
      {
        code: 'EUR',
        symbol: '€',
        rate: 100.5,
        fractionDigits: 2,
        manualRate: false,
        rateUpdatedAt: null,
      },
    ]);
  });

  it('fractionDigits доп.валюты не задан → добивается дефолтом 2', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'exchange',
        value: { displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 95 }] },
      },
    ]);
    expect(eff.exchange.displayCurrencies[0].fractionDigits).toBe(2);
  });
});
