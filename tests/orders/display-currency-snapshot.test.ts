import { describe, expect, it } from 'vitest';

import {
  resolveDisplaySnapshot,
  type DisplaySnapshotSettings,
} from '@/lib/orders/display-currency';

/**
 * СНИМОК ВАЛЮТЫ ОТОБРАЖЕНИЯ В ЗАКАЗЕ (миграция 0059, ЭТАП 2 мультивалюты).
 *
 * ЗАЧЕМ. Покупатель ходит по каталогу в евро, а списывают рубли: эквайринг
 * рублёвый (см. guard tests/exchange/payment-base-currency.test.ts). Дисклеймер
 * на чекауте называет обе суммы, но курс ЦБ меняется ежедневно — через неделю по
 * спорному заказу восстановить «что было на экране» невозможно. Снимок
 * (display_currency / display_rate / display_total) фиксирует это в момент заказа.
 *
 * ИНВАРИАНТЫ, которые сторожит этот тест:
 *   1) КЛИЕНТСКОЕ ЧИСЛО К ДЕНЬГАМ НЕ ДОПУСКАЕТСЯ (ADR-010 anti-tamper). От клиента
 *      принимается ТОЛЬКО КОД валюты; курс берётся из настроек магазина СЕРВЕРОМ,
 *      а display_total сервер считает сам от своего рублёвого итога.
 *   2) БАЗОВАЯ ВАЛЮТА → СНИМКА НЕТ (null). Рублёвый покупатель одновалютного
 *      магазина не должен получить ни строки данных — мультитенантность.
 *   3) ОКРУГЛЕНИЕ ОТ ИТОГА, а не суммированием округлённых позиций.
 *   4) ЕДИНИЦЫ: display_total — ДЕНЬГИ (рубли/евро) с двумя знаками, НЕ копейки.
 *   5) МУСОР В ЗАПРОСЕ/НАСТРОЙКАХ НЕ РОНЯЕТ ЗАКАЗ: неизвестный код, курс ≤ 0,
 *      отсутствие секции exchange → снимка просто нет, заказ создаётся как раньше.
 */

/** Настройки магазина: базовая ₽ + евро по курсу ЦБ 88,7602 ₽/€. */
const SETTINGS: DisplaySnapshotSettings = {
  currency: { code: 'RUB' },
  exchange: {
    displayCurrencies: [
      { code: 'EUR', rate: 88.7602 },
      { code: 'USD', rate: 79.5 },
    ],
  },
};

describe('resolveDisplaySnapshot — валюта отображения выбрана покупателем', () => {
  it('считает итог в валюте отображения СЕРВЕРОМ от рублёвого grand_total', () => {
    // 48000 ₽ / 88.7602 = 540.78…  → 540.78 €
    const snap = resolveDisplaySnapshot({
      requestedCurrency: 'EUR',
      grandTotal: '48000.00',
      settings: SETTINGS,
    });
    expect(snap).toEqual({
      displayCurrency: 'EUR',
      displayRate: '88.76020000',
      displayTotal: '540.78',
    });
  });

  it('код валюты нормализуется к ISO-канону (регистр/пробелы)', () => {
    const snap = resolveDisplaySnapshot({
      requestedCurrency: '  eur ',
      grandTotal: '8876.02',
      settings: SETTINGS,
    });
    expect(snap?.displayCurrency).toBe('EUR');
    expect(snap?.displayTotal).toBe('100.00');
  });

  it('ИТОГ считается ОТ РУБЛЁВОГО ИТОГА, а не суммированием округлённых позиций', () => {
    // Три позиции по 100.00 ₽ при курсе 3 ₽/€: каждая = 33.333… €.
    // Сумма ОКРУГЛЁННЫХ позиций: 33.33 × 3 = 99.99 € — расходится с итогом.
    // Правильный результат: 300.00 / 3 = 100.00 €.
    const snap = resolveDisplaySnapshot({
      requestedCurrency: 'EUR',
      grandTotal: '300.00',
      settings: { currency: { code: 'RUB' }, exchange: { displayCurrencies: [{ code: 'EUR', rate: 3 }] } },
    });
    expect(snap?.displayTotal).toBe('100.00');
  });

  it('ЕДИНИЦЫ: display_total — деньги с 2 знаками, а НЕ копейки', () => {
    const snap = resolveDisplaySnapshot({
      requestedCurrency: 'EUR',
      grandTotal: '177.52',
      settings: { currency: { code: 'RUB' }, exchange: { displayCurrencies: [{ code: 'EUR', rate: 88.76 }] } },
    });
    // 177.52 / 88.76 = 2 € ровно. Копеечная трактовка дала бы 200 — ловим её.
    expect(snap?.displayTotal).toBe('2.00');
  });

  it('нулевой итог (полностью покрыт сертификатом) → 0.00, снимок остаётся', () => {
    const snap = resolveDisplaySnapshot({
      requestedCurrency: 'EUR',
      grandTotal: '0.00',
      settings: SETTINGS,
    });
    expect(snap?.displayTotal).toBe('0.00');
    expect(snap?.displayCurrency).toBe('EUR');
  });
});

describe('resolveDisplaySnapshot — снимка НЕ должно быть', () => {
  it('покупатель смотрел в БАЗОВОЙ валюте → null (одновалютный магазин не заметит)', () => {
    expect(
      resolveDisplaySnapshot({
        requestedCurrency: 'RUB',
        grandTotal: '48000.00',
        settings: SETTINGS,
      }),
    ).toBeNull();
  });

  it('клиент вообще не прислал валюту отображения (старая витрина) → null', () => {
    for (const requested of [undefined, null, '', '   ']) {
      expect(
        resolveDisplaySnapshot({
          requestedCurrency: requested as string | undefined,
          grandTotal: '48000.00',
          settings: SETTINGS,
        }),
      ).toBeNull();
    }
  });

  it('🔴 НЕИЗВЕСТНАЯ валюта (подделка тела запроса) → null, а не выдуманный курс', () => {
    expect(
      resolveDisplaySnapshot({
        requestedCurrency: 'XXX',
        grandTotal: '48000.00',
        settings: SETTINGS,
      }),
    ).toBeNull();
  });

  it('курс ≤ 0 или не число в настройках → null (деление на ноль не случится)', () => {
    for (const rate of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveDisplaySnapshot({
          requestedCurrency: 'EUR',
          grandTotal: '48000.00',
          settings: {
            currency: { code: 'RUB' },
            exchange: { displayCurrencies: [{ code: 'EUR', rate: rate as number }] },
          },
        }),
      ).toBeNull();
    }
  });

  it('нет секции exchange / настроек вовсе → null, заказ создаётся как раньше', () => {
    expect(
      resolveDisplaySnapshot({
        requestedCurrency: 'EUR',
        grandTotal: '48000.00',
        settings: { currency: { code: 'RUB' } },
      }),
    ).toBeNull();
    expect(
      resolveDisplaySnapshot({
        requestedCurrency: 'EUR',
        grandTotal: '48000.00',
        settings: null,
      }),
    ).toBeNull();
  });

  it('нечитаемый рублёвый итог не роняет создание заказа → null', () => {
    expect(
      resolveDisplaySnapshot({
        requestedCurrency: 'EUR',
        grandTotal: 'не-число',
        settings: SETTINGS,
      }),
    ).toBeNull();
  });

  it('🔴 ПУСТОЙ итог → null, а НЕ выдуманное «клиент видел 0,00 €»', () => {
    // Ловушка: Number('') === 0. Без отдельной проверки отсутствующий итог тихо
    // стал бы снимком с нулём — ложный факт в карточке заказа.
    for (const total of ['', '   ']) {
      expect(
        resolveDisplaySnapshot({
          requestedCurrency: 'EUR',
          grandTotal: total,
          settings: SETTINGS,
        }),
      ).toBeNull();
    }
  });
});

describe('🔴 anti-tamper: снимок нельзя задать клиентом', () => {
  it('курс НЕ берётся из запроса — только из настроек магазина', () => {
    // Даже если клиент «подскажет» выгодный курс через лишние поля, resolveDisplaySnapshot
    // их не принимает: сигнатура несёт только КОД валюты и СЕРВЕРНЫЙ итог.
    const snap = resolveDisplaySnapshot({
      // @ts-expect-error — намеренная попытка протащить курс: поля в контракте нет.
      displayRate: '1.0',
      requestedCurrency: 'EUR',
      grandTotal: '88760.20',
      settings: SETTINGS,
    });
    expect(snap?.displayRate).toBe('88.76020000');
    expect(snap?.displayTotal).toBe('1000.00');
  });
});
