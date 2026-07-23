import { describe, it, expect, vi } from 'vitest';

/**
 * Защита воркера курсов от НЕ-рублёвой базовой валюты магазина (мультитенантность).
 *
 * ЦБ РФ отдаёт «рублей за единицу валюты», а витрина делит цену базовой валюты на
 * rate. Значит курсы ЦБ применимы ТОЛЬКО когда базовая валюта магазина = RUB.
 * На магазине с другой базой (форма админки разрешает любой ISO-код) автообновление
 * записало бы заведомо неверный курс и молча испортило цены — поэтому воркер обязан
 * не трогать настройки и вернуть reason:'unsupported_base'.
 *
 * Без сети/БД: все зависимости инъецируются моком.
 */

import {
  runUpdateExchangeRates,
  isCbrBaseSupported,
  CBR_BASE_CURRENCY,
  type CbrResponse,
  type UpdateRatesDeps,
} from '@/lib/exchange/cron';
import type { ExchangeSettings } from '@/lib/settings/schemas';

const CBR_FIXTURE: CbrResponse = { Valute: { EUR: { Value: 100.5, Nominal: 1 } } };

function baseDeps(
  exchange: ExchangeSettings,
  write: UpdateRatesDeps['writeExchange'],
  readBaseCurrency?: UpdateRatesDeps['readBaseCurrency'],
): UpdateRatesDeps {
  return {
    fetchCbr: vi.fn(async () => CBR_FIXTURE),
    readExchange: vi.fn(async () => exchange),
    writeExchange: write,
    ...(readBaseCurrency ? { readBaseCurrency } : {}),
  };
}

const EXCHANGE_EUR: ExchangeSettings = {
  autoRate: true,
  displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 90, fractionDigits: 2 }],
};

describe('isCbrBaseSupported — применимость источника ЦБ РФ к базовой валюте магазина', () => {
  it('базовая RUB → источник применим', () => {
    expect(isCbrBaseSupported(CBR_BASE_CURRENCY)).toBe(true);
    expect(isCbrBaseSupported('rub')).toBe(true);
    expect(isCbrBaseSupported(' RUB ')).toBe(true);
  });

  it('базовая не RUB → источник НЕ применим', () => {
    expect(isCbrBaseSupported('USD')).toBe(false);
    expect(isCbrBaseSupported('EUR')).toBe(false);
    expect(isCbrBaseSupported('KZT')).toBe(false);
  });

  it('база неизвестна (настройки не прочитались) → не блокируем прогон', () => {
    expect(isCbrBaseSupported(undefined)).toBe(true);
    expect(isCbrBaseSupported(null)).toBe(true);
    expect(isCbrBaseSupported('')).toBe(true);
  });
});

describe('runUpdateExchangeRates — гейт базовой валюты', () => {
  it('база не RUB → курсы НЕ записаны, ЦБ не опрашивается, reason=unsupported_base', async () => {
    const write = vi.fn(async (_s: ExchangeSettings) => {});
    const d = baseDeps(EXCHANGE_EUR, write, async () => 'USD');

    const stats = await runUpdateExchangeRates(d);

    expect(stats.reason).toBe('unsupported_base');
    expect(stats.updated).toBe(0);
    // Это НЕ сбой: источник просто неприменим к этому магазину (крон остаётся зелёным).
    expect(stats.ok).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(d.fetchCbr).not.toHaveBeenCalled();
  });

  it('база не RUB → существующий (ручной) курс в настройках не затёрт', async () => {
    const store: ExchangeSettings = {
      autoRate: true,
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 90, fractionDigits: 2 }],
    };
    const write = vi.fn(async (v: ExchangeSettings) => {
      store.displayCurrencies = v.displayCurrencies;
    });
    const d = baseDeps(store, write, async () => 'KZT');

    await runUpdateExchangeRates(d);

    expect(store.displayCurrencies?.[0].rate).toBe(90);
  });

  it('база RUB → happy path: курс с ЦБ записан', async () => {
    const write = vi.fn(async (_s: ExchangeSettings) => {});
    const d = baseDeps(EXCHANGE_EUR, write, async () => 'RUB');

    const stats = await runUpdateExchangeRates(d);

    expect(stats).toEqual({ ok: true, updated: 1, missing: [], skipped: [] });
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0][0] as ExchangeSettings).displayCurrencies?.[0].rate).toBe(100.5);
  });

  it('база не читается (dep не задан) → обратная совместимость: курс обновляется', async () => {
    const write = vi.fn(async (_s: ExchangeSettings) => {});
    const d = baseDeps(EXCHANGE_EUR, write);

    const stats = await runUpdateExchangeRates(d);

    expect(stats.reason).toBeUndefined();
    expect(stats.updated).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('ручной режим (autoRate=false) на не-RUB магазине → всё тот же no-op, настройки целы', async () => {
    const write = vi.fn(async (_s: ExchangeSettings) => {});
    const d = baseDeps({ ...EXCHANGE_EUR, autoRate: false }, write, async () => 'USD');

    const stats = await runUpdateExchangeRates(d);

    expect(stats.ok).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});
