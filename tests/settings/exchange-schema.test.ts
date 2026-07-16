import { describe, it, expect } from 'vitest';

/**
 * Мультивалюта (₽/€) — витринное отображение (docs решение владельца):
 *   • базовая валюта = RUB (currency.code), цены товаров хранятся в рублях;
 *   • евро (и любые доп.валюты) — ТОЛЬКО показ по курсу; ключ настроек `exchange`;
 *   • rate = единиц базовой за 1 единицу отображаемой (EUR rate=100 → 1€=100₽);
 *   • autoRate — обновлять ли rate кроном с ЦБ РФ; rateUpdatedAt — метка последнего
 *     обновления курса (для UI/диагностики).
 *
 * Тест схемы: валидные/невалидные значения exchange (Zod .strip() анти-tamper JSONB).
 */

import { parseSettingValue, exchangeSchema, SETTING_KEYS } from '@/lib/settings/schemas';

describe('settings/schemas — exchange (мультивалюта отображения)', () => {
  it('exchange входит в реестр ключей настроек', () => {
    expect(SETTING_KEYS).toContain('exchange');
  });

  it('валидный exchange: displayCurrencies + autoRate + rateUpdatedAt', () => {
    const value = {
      autoRate: true,
      rateUpdatedAt: '2026-07-16T10:00:00.000Z',
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 100.5, fractionDigits: 2 }],
    };
    const parsed = parseSettingValue('exchange', value);
    expect(parsed).not.toBeNull();
    expect(parsed?.displayCurrencies?.[0]).toEqual({
      code: 'EUR',
      symbol: '€',
      rate: 100.5,
      fractionDigits: 2,
    });
    expect(parsed?.autoRate).toBe(true);
    expect(parsed?.rateUpdatedAt).toBe('2026-07-16T10:00:00.000Z');
  });

  it('fractionDigits в валюте отображения опционален (дефолт добьётся в эффективных настройках)', () => {
    const parsed = parseSettingValue('exchange', {
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 95 }],
    });
    expect(parsed?.displayCurrencies?.[0].fractionDigits).toBeUndefined();
  });

  it('пустой объект {} валиден (нет оверрайда → нет доп.валют)', () => {
    expect(parseSettingValue('exchange', {})).toEqual({});
  });

  it('отбрасывает неизвестные поля (.strip() анти-tamper)', () => {
    const parsed = exchangeSchema.parse({
      autoRate: false,
      hacked: 'x',
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 100, evil: 1 }],
    });
    expect((parsed as Record<string, unknown>).hacked).toBeUndefined();
    expect((parsed.displayCurrencies![0] as Record<string, unknown>).evil).toBeUndefined();
  });

  it('rate ≤ 0 → невалидно (нельзя делить на ноль/отрицательный курс)', () => {
    expect(parseSettingValue('exchange', {
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 0 }],
    })).toBeNull();
    expect(parseSettingValue('exchange', {
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: -5 }],
    })).toBeNull();
  });

  it('code — 3 заглавные латинские (ISO 4217), иначе невалидно', () => {
    expect(parseSettingValue('exchange', {
      displayCurrencies: [{ code: 'eu', symbol: '€', rate: 100 }],
    })).toBeNull();
  });

  it('symbol обязателен и непустой', () => {
    expect(parseSettingValue('exchange', {
      displayCurrencies: [{ code: 'EUR', symbol: '', rate: 100 }],
    })).toBeNull();
  });
});
