import { describe, expect, it } from 'vitest';

import { runRoundDisplayPrices } from '@/lib/exchange/round-display-prices-worker';

/**
 * Воркер пересчёта витринных ценников (задача крона `round-display-prices`).
 *
 * Владелец выбрал автоматический пересчёт: цены в евро должны оставаться
 * круглыми И актуальными при движении курса ЦБ. Воркер ходит по каталогу
 * страницами и пишет только изменившееся.
 *
 * Логика инъектируется (как в runUpdateExchangeRates) — тест без БД и сети.
 */

/** Фикстура: магазин с EUR/USD и включённым автокурсом. */
function deps(overrides: Partial<Parameters<typeof runRoundDisplayPrices>[0]> = {}) {
  const written: { id: string; displayPrices: Record<string, string> }[] = [];
  return {
    written,
    args: {
      readExchange: async () => ({
        autoRate: true,
        displayCurrencies: [
          { code: 'EUR', rate: 89.6292, symbol: '€', fractionDigits: 2 },
          { code: 'USD', rate: 78.698, symbol: '$', fractionDigits: 2 },
        ],
      }),
      readProductsPage: async (offset: number) =>
        offset === 0
          ? [
              { id: 'p1', basePrice: '16000.00', displayPrices: {} },
              { id: 'p2', basePrice: '999.00', displayPrices: {} },
            ]
          : [],
      writeDisplayPrices: async (
        rows: { id: string; displayPrices: Record<string, string> }[],
      ) => {
        written.push(...rows);
      },
      ...overrides,
    } as Parameters<typeof runRoundDisplayPrices>[0],
  };
}

describe('воркер пересчёта цен показа', () => {
  it('проставляет круглые цены во всех валютах показа', async () => {
    const d = deps();
    const stats = await runRoundDisplayPrices(d.args);

    expect(stats).toMatchObject({ ok: true, scanned: 2, updated: 2 });
    expect(d.written).toEqual([
      { id: 'p1', displayPrices: { EUR: '179.00', USD: '203.00' } },
      { id: 'p2', displayPrices: { EUR: '11.00', USD: '13.00' } },
    ]);
  });

  it('повторный прогон на том же курсе ничего не пишет (идемпотентность)', async () => {
    const d = deps({
      readProductsPage: async (offset: number) =>
        offset === 0
          ? [{ id: 'p1', basePrice: '16000.00', displayPrices: { EUR: '179.00', USD: '203.00' } }]
          : [],
    });

    const stats = await runRoundDisplayPrices(d.args);

    expect(stats).toMatchObject({ ok: true, scanned: 1, updated: 0 });
    expect(d.written).toEqual([]);
  });

  it('магазин без доп.валют — честный no-op, а не ошибка', async () => {
    const d = deps({
      readExchange: async () => ({ autoRate: true, displayCurrencies: [] }),
    });

    const stats = await runRoundDisplayPrices(d.args);

    expect(stats).toMatchObject({ ok: true, updated: 0, reason: 'no_display_currencies' });
    expect(d.written).toEqual([]);
  });

  it('идёт по каталогу страницами, а не одним запросом', async () => {
    // 846 товаров в одном SELECT + один UPDATE на всё — это долгая транзакция
    // и блокировки на живом магазине. Ходим страницами.
    const seen: number[] = [];
    const d = deps({
      readProductsPage: async (offset: number) => {
        seen.push(offset);
        if (offset === 0) return [{ id: 'a', basePrice: '999.00', displayPrices: {} }];
        if (offset === 1) return [{ id: 'b', basePrice: '999.00', displayPrices: {} }];
        return [];
      },
      pageSize: 1,
    });

    const stats = await runRoundDisplayPrices(d.args);

    expect(seen).toEqual([0, 1, 2]);
    expect(stats).toMatchObject({ scanned: 2, updated: 2 });
  });

  it('сбой записи не прячется под успехом', async () => {
    const d = deps({
      writeDisplayPrices: async () => {
        throw new Error('БД недоступна');
      },
    });

    const stats = await runRoundDisplayPrices(d.args);

    expect(stats.ok).toBe(false);
    expect(stats.reason).toBe('write_failed');
  });

  it('негодный курс валюты не роняет прогон целиком', async () => {
    const d = deps({
      readExchange: async () => ({
        autoRate: true,
        displayCurrencies: [
          { code: 'EUR', rate: 89.6292, symbol: '€', fractionDigits: 2 },
          { code: 'USD', rate: 0, symbol: '$', fractionDigits: 2 },
        ],
      }),
    });

    const stats = await runRoundDisplayPrices(d.args);

    expect(stats.ok).toBe(true);
    // USD выпал, EUR посчитан.
    expect(d.written[0]!.displayPrices).toEqual({ EUR: '179.00' });
  });
});
