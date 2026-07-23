import { describe, it, expect, vi } from 'vitest';

/**
 * Тесты воркера обновления курсов валют с ЦБ РФ (мультивалюта витрины).
 *
 * Всё без сети/БД: fetchCbr/readExchange/writeExchange инъецируются моком.
 * Проверяем: парсинг фикстуры ЦБ (EUR.Value/Nominal → rate), запись rate,
 * идемпотентность, no-op при autoRate=false / без доп.валют, устойчивость к сбою
 * ЦБ (прежний курс сохраняется, ok:false), валюта не из ответа ЦБ → missing.
 */

import {
  runUpdateExchangeRates,
  applyCbrRates,
  extractRate,
  type CbrResponse,
  type UpdateRatesDeps,
} from '@/lib/exchange/cron';
import type { ExchangeSettings } from '@/lib/settings/schemas';

/** Фикстура ответа ЦБ РФ (форма cbr-xml-daily): EUR Nominal=1, USD Nominal=1. */
const CBR_FIXTURE: CbrResponse = {
  Valute: {
    USD: { Value: 88.4, Nominal: 1 },
    EUR: { Value: 100.5, Nominal: 1 },
    // Валюта с Nominal>1 (пример: JPY обычно за 100) — rate = Value/Nominal.
    JPY: { Value: 55, Nominal: 100 },
  },
};

function deps(
  exchange: ExchangeSettings,
  cbr: CbrResponse | Error,
  writeExchange: UpdateRatesDeps['writeExchange'] = vi.fn(async (_s: ExchangeSettings) => {}),
): UpdateRatesDeps {
  return {
    fetchCbr: vi.fn(async () => {
      if (cbr instanceof Error) throw cbr;
      return cbr;
    }),
    readExchange: vi.fn(async () => exchange),
    writeExchange,
  };
}

// ---------------------------------------------------------------------------
// extractRate / applyCbrRates (чистый парсинг)
// ---------------------------------------------------------------------------

describe('exchange — extractRate (парсинг ЦБ)', () => {
  it('EUR Nominal=1 → rate = Value', () => {
    expect(extractRate(CBR_FIXTURE, 'EUR')).toBe(100.5);
  });
  it('Nominal>1 → rate = Value / Nominal (JPY 55/100)', () => {
    expect(extractRate(CBR_FIXTURE, 'JPY')).toBeCloseTo(0.55, 6);
  });
  it('нет валюты в ответе → null', () => {
    expect(extractRate(CBR_FIXTURE, 'GBP')).toBeNull();
  });
  it('битые данные (Value<=0) → null', () => {
    expect(extractRate({ Valute: { EUR: { Value: 0, Nominal: 1 } } }, 'EUR')).toBeNull();
  });
});

describe('exchange — applyCbrRates', () => {
  it('обновляет rate у известных валют, symbol/fractionDigits не трогает', () => {
    const { currencies, updated, missing, skipped } = applyCbrRates(
      [{ code: 'EUR', symbol: '€', rate: 90, fractionDigits: 2 }],
      CBR_FIXTURE,
    );
    expect(currencies[0]).toEqual({ code: 'EUR', symbol: '€', rate: 100.5, fractionDigits: 2 });
    expect(updated).toBe(1);
    expect(missing).toEqual([]);
    expect(skipped).toEqual([]);
  });
  it('валюта не из ответа ЦБ → прежний rate, попадает в missing', () => {
    const { currencies, updated, missing } = applyCbrRates(
      [{ code: 'GBP', symbol: '£', rate: 110 }],
      CBR_FIXTURE,
    );
    expect(currencies[0].rate).toBe(110); // прежний
    expect(updated).toBe(0);
    expect(missing).toEqual(['GBP']);
  });
});

// ---------------------------------------------------------------------------
// runUpdateExchangeRates (воркер)
// ---------------------------------------------------------------------------

describe('runUpdateExchangeRates', () => {
  it('autoRate=true + EUR → тянет ЦБ, пишет rate=100.5, ok', async () => {
    const write = vi.fn(async (_s: ExchangeSettings) => {});
    const d = deps(
      { autoRate: true, displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 90, fractionDigits: 2 }] },
      CBR_FIXTURE,
      write,
    );
    const stats = await runUpdateExchangeRates(d);
    expect(stats).toEqual({ ok: true, updated: 1, missing: [], skipped: [] });
    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0][0] as ExchangeSettings;
    expect(written.displayCurrencies?.[0].rate).toBe(100.5);
    // autoRate сохраняется в записи.
    expect(written.autoRate).toBe(true);
  });

  it('autoRate=false → no-op (магазин ведёт курс вручную), запись не вызывается', async () => {
    const write = vi.fn(async () => {});
    const d = deps(
      { autoRate: false, displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 90 }] },
      CBR_FIXTURE,
      write,
    );
    const stats = await runUpdateExchangeRates(d);
    expect(stats.reason).toBe('auto_rate_off');
    expect(stats.updated).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(d.fetchCbr).not.toHaveBeenCalled();
  });

  it('нет доп.валют → no-op (нечего обновлять)', async () => {
    const write = vi.fn(async () => {});
    const d = deps({ autoRate: true, displayCurrencies: [] }, CBR_FIXTURE, write);
    const stats = await runUpdateExchangeRates(d);
    expect(stats.reason).toBe('no_currencies');
    expect(write).not.toHaveBeenCalled();
  });

  it('сбой ЦБ (fetch бросает) → прежний курс сохранён, ok:false, запись не вызывается', async () => {
    const write = vi.fn(async () => {});
    const d = deps(
      { autoRate: true, displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 90 }] },
      new Error('network down'),
      write,
    );
    const stats = await runUpdateExchangeRates(d);
    expect(stats.ok).toBe(false);
    expect(stats.reason).toBe('fetch_failed');
    expect(write).not.toHaveBeenCalled();
  });

  it('все валюты отсутствуют в ответе ЦБ → updated=0, запись не вызывается (no-op)', async () => {
    const write = vi.fn(async () => {});
    const d = deps(
      { autoRate: true, displayCurrencies: [{ code: 'GBP', symbol: '£', rate: 110 }] },
      CBR_FIXTURE,
      write,
    );
    const stats = await runUpdateExchangeRates(d);
    expect(stats.updated).toBe(0);
    expect(stats.missing).toEqual(['GBP']);
    expect(write).not.toHaveBeenCalled();
  });

  it('идемпотентность: повторный прогон пишет тот же rate', async () => {
    const write = vi.fn(async (_s: ExchangeSettings) => {});
    const start: ExchangeSettings = {
      autoRate: true,
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 100.5, fractionDigits: 2 }],
    };
    const d = deps(start, CBR_FIXTURE, write);
    await runUpdateExchangeRates(d);
    const written = write.mock.calls[0][0] as ExchangeSettings;
    expect(written.displayCurrencies?.[0].rate).toBe(100.5);
  });
});
