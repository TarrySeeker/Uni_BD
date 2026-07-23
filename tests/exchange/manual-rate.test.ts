import { describe, it, expect, vi } from 'vitest';

/**
 * ПЕР-ВАЛЮТНЫЙ ручной курс (ТЗ владельца п.10, решение «только ручной курс»).
 *
 * Суть: признак «курс задан вручную» и метка обновления живут У КАЖДОЙ ВАЛЮТЫ,
 * а не одним флагом на весь раздел. Ночной крон обязан обходить ручные валюты
 * стороной и обновлять остальные; снятие признака возвращает валюту на автокурс.
 *
 * 🔴 ГЛАВНЫЙ РИСК: новые поля обязаны быть ОПЦИОНАЛЬНЫМИ — на стенде уже лежит
 * значение БЕЗ них, а parseSettingValue при несовпадении схемы вернул бы null и
 * МОЛЧА уронил бы весь раздел exchange на дефолты (список валют опустеет →
 * переключатель валют исчезнет с витрины). Обратная совместимость закрыта тестом
 * именно на реальном значении стенда (см. STAND_EXCHANGE_VALUE).
 *
 * Без сети/БД: все зависимости воркера инъецируются моком.
 */

import {
  runUpdateExchangeRates,
  applyCbrRates,
  isManualRate,
  type CbrResponse,
  type UpdateRatesDeps,
} from '@/lib/exchange/cron';
import { mergeCronRates, stampManualSave } from '@/lib/exchange/merge';
import { parseSettingValue, type ExchangeSettings } from '@/lib/settings/schemas';
import { mergeSettings } from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';

const CBR: CbrResponse = {
  Valute: {
    USD: { Value: 88.4, Nominal: 1 },
    EUR: { Value: 100.5, Nominal: 1 },
  },
};

const NOW = '2026-07-23T10:00:00.000Z';

function deps(
  exchange: ExchangeSettings,
  write: UpdateRatesDeps['writeExchange'] = vi.fn(async () => {}),
): UpdateRatesDeps {
  return {
    fetchCbr: vi.fn(async () => CBR),
    readExchange: vi.fn(async () => exchange),
    writeExchange: write,
    now: () => NOW,
  };
}

// =============================================================================
// C1. Обратная совместимость со СТЕНДОМ.
// =============================================================================

/**
 * СНЯТО СО СТЕНДА (read-only SQL, 2026-07-23):
 *   select setting_key, value from shop_settings where setting_key='exchange';
 *   exchange => {"autoRate": true, "displayCurrencies":
 *                [{"code":"EUR","rate":89.33,"symbol":"€","fractionDigits":2}]}
 * Ни manualRate, ни пер-валютного rateUpdatedAt там НЕТ.
 */
const STAND_EXCHANGE_VALUE = {
  autoRate: true,
  displayCurrencies: [{ code: 'EUR', rate: 89.33, symbol: '€', fractionDigits: 2 }],
};

describe('обратная совместимость: реальное значение exchange со стенда', () => {
  it('парсится схемой (НЕ null) — иначе раздел молча упал бы на дефолты', () => {
    const parsed = parseSettingValue('exchange', STAND_EXCHANGE_VALUE);
    expect(parsed).not.toBeNull();
    expect(parsed?.displayCurrencies).toHaveLength(1);
    expect(parsed?.displayCurrencies?.[0].code).toBe('EUR');
    expect(parsed?.displayCurrencies?.[0].rate).toBe(89.33);
  });

  it('новые поля отсутствуют → undefined, а не ошибка валидации', () => {
    const parsed = parseSettingValue('exchange', STAND_EXCHANGE_VALUE);
    expect(parsed?.displayCurrencies?.[0].manualRate).toBeUndefined();
    expect(parsed?.displayCurrencies?.[0].rateUpdatedAt).toBeUndefined();
  });

  it('merge-слой: валюта стенда доезжает до витрины, manualRate по умолчанию false', () => {
    const eff = mergeSettings(getEnv({ NODE_ENV: 'test', SHOP_CURRENCY: 'RUB' }), [
      { setting_key: 'exchange', value: STAND_EXCHANGE_VALUE },
    ]);
    expect(eff.exchange.displayCurrencies).toEqual([
      {
        code: 'EUR',
        symbol: '€',
        rate: 89.33,
        fractionDigits: 2,
        manualRate: false,
        rateUpdatedAt: null,
      },
    ]);
  });

  it('крон на значении стенда работает как раньше: EUR обновляется', async () => {
    const write = vi.fn(async (_v: ExchangeSettings) => {});
    const stats = await runUpdateExchangeRates(
      deps(parseSettingValue('exchange', STAND_EXCHANGE_VALUE)!, write),
    );
    expect(stats.ok).toBe(true);
    expect(stats.updated).toBe(1);
    expect(stats.skipped).toEqual([]);
    expect((write.mock.calls[0][0] as ExchangeSettings).displayCurrencies?.[0].rate).toBe(100.5);
  });
});

// =============================================================================
// C2. Крон уважает пер-валютный ручной курс.
// =============================================================================

describe('isManualRate', () => {
  it('признак не задан → валюта автоматическая', () => {
    expect(isManualRate({ code: 'EUR', symbol: '€', rate: 90 })).toBe(false);
    expect(isManualRate({ code: 'EUR', symbol: '€', rate: 90, manualRate: false })).toBe(false);
  });
  it('признак задан → валюта ручная', () => {
    expect(isManualRate({ code: 'USD', symbol: '$', rate: 80, manualRate: true })).toBe(true);
  });
});

describe('applyCbrRates — ручные валюты неприкосновенны', () => {
  it('ручная не тронута, автоматическая обновлена', () => {
    const { currencies, updated, missing, skipped } = applyCbrRates(
      [
        { code: 'USD', symbol: '$', rate: 70, fractionDigits: 2, manualRate: true },
        { code: 'EUR', symbol: '€', rate: 90, fractionDigits: 2 },
      ],
      CBR,
      NOW,
    );
    // Ручной USD: rate прежний (70, а не 88.4), метка не переписана.
    expect(currencies[0]).toEqual({
      code: 'USD',
      symbol: '$',
      rate: 70,
      fractionDigits: 2,
      manualRate: true,
    });
    // Автоматический EUR: курс ЦБ + своя метка обновления.
    expect(currencies[1].rate).toBe(100.5);
    expect(currencies[1].rateUpdatedAt).toBe(NOW);
    expect(updated).toBe(1);
    expect(skipped).toEqual(['USD']);
    expect(missing).toEqual([]);
  });

  it('все валюты ручные → обновлять нечего (записи не будет)', () => {
    const { updated, skipped } = applyCbrRates(
      [{ code: 'EUR', symbol: '€', rate: 90, manualRate: true }],
      CBR,
      NOW,
    );
    expect(updated).toBe(0);
    expect(skipped).toEqual(['EUR']);
  });
});

describe('runUpdateExchangeRates — пер-валютный ручной курс', () => {
  it('USD ручной, EUR авто → пишется только EUR, USD сохраняет свой курс', async () => {
    const write = vi.fn(async (_v: ExchangeSettings) => {});
    const stats = await runUpdateExchangeRates(
      deps(
        {
          autoRate: true,
          displayCurrencies: [
            { code: 'USD', symbol: '$', rate: 70, manualRate: true },
            { code: 'EUR', symbol: '€', rate: 90 },
          ],
        },
        write,
      ),
    );
    expect(stats.updated).toBe(1);
    expect(stats.skipped).toEqual(['USD']);
    const written = write.mock.calls[0][0] as ExchangeSettings;
    expect(written.displayCurrencies?.[0]).toMatchObject({ code: 'USD', rate: 70 });
    expect(written.displayCurrencies?.[1]).toMatchObject({ code: 'EUR', rate: 100.5 });
  });

  it('все валюты ручные → записи в настройки НЕ происходит вовсе', async () => {
    const write = vi.fn(async (_v: ExchangeSettings) => {});
    const stats = await runUpdateExchangeRates(
      deps(
        {
          autoRate: true,
          displayCurrencies: [
            { code: 'USD', symbol: '$', rate: 70, manualRate: true },
            { code: 'EUR', symbol: '€', rate: 90, manualRate: true },
          ],
        },
        write,
      ),
    );
    expect(write).not.toHaveBeenCalled();
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toEqual(['USD', 'EUR']);
  });

  // C3: возврат на автокурс — сняли признак, следующий прогон подхватывает валюту.
  it('снятие признака ручного курса → следующий прогон обновляет валюту', async () => {
    const manual: ExchangeSettings = {
      autoRate: true,
      displayCurrencies: [{ code: 'USD', symbol: '$', rate: 70, manualRate: true }],
    };
    const w1 = vi.fn(async (_v: ExchangeSettings) => {});
    await runUpdateExchangeRates(deps(manual, w1));
    expect(w1).not.toHaveBeenCalled();

    // Владелец снял галочку (manualRate:false) → та же валюта становится автоматической.
    const auto: ExchangeSettings = {
      autoRate: true,
      displayCurrencies: [{ code: 'USD', symbol: '$', rate: 70, manualRate: false }],
    };
    const w2 = vi.fn(async (_v: ExchangeSettings) => {});
    const stats = await runUpdateExchangeRates(deps(auto, w2));
    expect(stats.updated).toBe(1);
    expect((w2.mock.calls[0][0] as ExchangeSettings).displayCurrencies?.[0].rate).toBe(88.4);
  });

  // C8: USD поддержан источником ЦБ наравне с EUR.
  it('USD на автокурсе получает курс ЦБ (88.4)', async () => {
    const write = vi.fn(async (_v: ExchangeSettings) => {});
    await runUpdateExchangeRates(
      deps(
        { autoRate: true, displayCurrencies: [{ code: 'USD', symbol: '$', rate: 1, fractionDigits: 2 }] },
        write,
      ),
    );
    const written = write.mock.calls[0][0] as ExchangeSettings;
    expect(written.displayCurrencies?.[0]).toEqual({
      code: 'USD',
      symbol: '$',
      rate: 88.4,
      fractionDigits: 2,
      rateUpdatedAt: NOW,
    });
  });
});

// =============================================================================
// C4. Гонка read-modify-write.
// =============================================================================

describe('mergeCronRates — крон не затирает то, что изменилось между чтением и записью', () => {
  it('признак «ручной», выставленный во время прогона, НЕ теряется', () => {
    // Крон прочитал USD автоматическим и посчитал новый курс…
    const computed = [{ code: 'USD', symbol: '$', rate: 88.4, rateUpdatedAt: NOW }];
    // …а владелец в это время пометил USD ручным и вписал свой курс.
    const latest: ExchangeSettings = {
      autoRate: true,
      displayCurrencies: [{ code: 'USD', symbol: '$', rate: 75, manualRate: true }],
    };
    const merged = mergeCronRates(latest, computed);
    expect(merged.displayCurrencies).toEqual([
      { code: 'USD', symbol: '$', rate: 75, manualRate: true },
    ]);
  });

  it('валюта, добавленная во время прогона, не исчезает', () => {
    const computed = [{ code: 'EUR', symbol: '€', rate: 100.5, rateUpdatedAt: NOW }];
    const latest: ExchangeSettings = {
      autoRate: true,
      displayCurrencies: [
        { code: 'EUR', symbol: '€', rate: 90 },
        { code: 'USD', symbol: '$', rate: 80 },
      ],
    };
    const merged = mergeCronRates(latest, computed);
    expect(merged.displayCurrencies?.map((c) => c.code)).toEqual(['EUR', 'USD']);
    expect(merged.displayCurrencies?.[0].rate).toBe(100.5);
    // USD крон не считал (в его снимке валюты не было) → остаётся как есть.
    expect(merged.displayCurrencies?.[1].rate).toBe(80);
  });

  it('валюта, удалённая во время прогона, не воскресает', () => {
    const computed = [
      { code: 'EUR', symbol: '€', rate: 100.5 },
      { code: 'USD', symbol: '$', rate: 88.4 },
    ];
    const latest: ExchangeSettings = {
      autoRate: true,
      displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 90 }],
    };
    expect(mergeCronRates(latest, computed).displayCurrencies?.map((c) => c.code)).toEqual(['EUR']);
  });

  it('autoRate берётся из СВЕЖЕГО снимка, а не из устаревшего', () => {
    const merged = mergeCronRates(
      { autoRate: false, displayCurrencies: [] },
      [{ code: 'EUR', symbol: '€', rate: 100.5 }],
    );
    expect(merged.autoRate).toBe(false);
  });
});

describe('stampManualSave — ручное сохранение формы', () => {
  it('изменённый курс получает свежую метку', () => {
    const next = stampManualSave(
      { displayCurrencies: [{ code: 'USD', symbol: '$', rate: 70, rateUpdatedAt: '2020-01-01T00:00:00.000Z' }] },
      [{ code: 'USD', symbol: '$', rate: 75, manualRate: true }],
      NOW,
    );
    expect(next[0].rateUpdatedAt).toBe(NOW);
  });

  it('неизменённый курс сохраняет прежнюю метку (не выдаёт авто-курс за ручной)', () => {
    const next = stampManualSave(
      { displayCurrencies: [{ code: 'EUR', symbol: '€', rate: 100.5, rateUpdatedAt: '2026-07-01T00:00:00.000Z' }] },
      [{ code: 'EUR', symbol: '€', rate: 100.5 }],
      NOW,
    );
    expect(next[0].rateUpdatedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('новая валюта получает метку сохранения', () => {
    const next = stampManualSave({}, [{ code: 'USD', symbol: '$', rate: 80 }], NOW);
    expect(next[0].rateUpdatedAt).toBe(NOW);
  });
});
