import { describe, expect, it } from 'vitest';

import {
  applyServerRates,
  ratesSignature,
  rowsFromServer,
  type DisplayCurrencyRow,
  type ServerDisplayCurrency,
} from '@/app/admin/(panel)/settings/_components/currency-form-state';

/**
 * ПЕРЕСЕВ КУРСОВ В ФОРМЕ ПОСЛЕ РУЧНОГО ОБНОВЛЕНИЯ С ЦБ.
 *
 * Дефект: строки формы жили в useState, засеянном первыми пропсами. После кнопки
 * «Обновить курсы с ЦБ сейчас» router.refresh() перерисовывает серверную страницу,
 * но состояние клиентского компонента React сохраняет — форма продолжала показывать
 * СТАРЫЕ курсы (кнопка выглядела сломанной), а следующее «Сохранить» записывало эти
 * старые курсы обратно в БД, откатывая только что полученные свежие.
 *
 * Здесь тестируется чистая логика пересева: свежий серверный снимок накладывается
 * ТОЛЬКО на курсы автоматических валют, а несохранённые ручные правки владельца
 * (коды, символы, знаки, галочка «ручной курс», добавленные/удалённые строки)
 * переживают пересев.
 */

function srv(p: Partial<ServerDisplayCurrency> & { code: string }): ServerDisplayCurrency {
  return {
    symbol: '',
    rate: 1,
    fractionDigits: 2,
    manualRate: false,
    rateUpdatedAt: null,
    ...p,
  };
}

function row(p: Partial<DisplayCurrencyRow> & { code: string }): DisplayCurrencyRow {
  return {
    symbol: '',
    rate: '1',
    fractionDigits: '2',
    manualRate: false,
    rateUpdatedAt: null,
    ...p,
  };
}

describe('rowsFromServer — засев строк формы из настроек', () => {
  it('числа настроек превращаются в строки полей ввода, признаки сохраняются', () => {
    expect(
      rowsFromServer([
        srv({ code: 'EUR', symbol: '€', rate: 100.5, fractionDigits: 2, rateUpdatedAt: '2026-07-01T00:00:00.000Z' }),
      ]),
    ).toEqual([
      {
        code: 'EUR',
        symbol: '€',
        rate: '100.5',
        fractionDigits: '2',
        manualRate: false,
        rateUpdatedAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });

  it('пустой снимок → пустой список строк', () => {
    expect(rowsFromServer([])).toEqual([]);
  });
});

describe('ratesSignature — детектор «сервер отдал другие курсы»', () => {
  it('одинаковые снимки дают одинаковую подпись (лишнего пересева не будет)', () => {
    const a = [srv({ code: 'EUR', rate: 100 }), srv({ code: 'USD', rate: 90 })];
    const b = [srv({ code: 'EUR', rate: 100 }), srv({ code: 'USD', rate: 90 })];
    expect(ratesSignature(a)).toBe(ratesSignature(b));
  });

  it('изменившийся курс меняет подпись', () => {
    expect(ratesSignature([srv({ code: 'EUR', rate: 100 })])).not.toBe(
      ratesSignature([srv({ code: 'EUR', rate: 101 })]),
    );
  });

  it('изменившаяся метка обновления меняет подпись (курс тот же, дата новая)', () => {
    expect(ratesSignature([srv({ code: 'EUR', rate: 100, rateUpdatedAt: 'a' })])).not.toBe(
      ratesSignature([srv({ code: 'EUR', rate: 100, rateUpdatedAt: 'b' })]),
    );
  });

  it('подпись НЕ реагирует на поля, которые пересев не копирует (символ/знаки)', () => {
    // Иначе правка символа на сервере дёргала бы пересев курсов без причины.
    expect(ratesSignature([srv({ code: 'EUR', rate: 100, symbol: '€', fractionDigits: 2 })])).toBe(
      ratesSignature([srv({ code: 'EUR', rate: 100, symbol: 'E', fractionDigits: 4 })]),
    );
  });

  it('состав валют влияет на подпись', () => {
    expect(ratesSignature([srv({ code: 'EUR' })])).not.toBe(
      ratesSignature([srv({ code: 'EUR' }), srv({ code: 'USD' })]),
    );
  });
});

describe('applyServerRates — свежие курсы поверх формы', () => {
  it('автокурс подтягивается: форма показывает то, что лежит в БД', () => {
    const next = applyServerRates(
      [row({ code: 'EUR', rate: '100' })],
      [srv({ code: 'EUR', rate: 105.25, rateUpdatedAt: '2026-07-23T03:00:00.000Z' })],
    );
    expect(next[0].rate).toBe('105.25');
    expect(next[0].rateUpdatedAt).toBe('2026-07-23T03:00:00.000Z');
  });

  it('НЕ трогает валюту с ручным курсом (прогон её и не обновлял)', () => {
    const next = applyServerRates(
      [row({ code: 'EUR', rate: '77', manualRate: true, rateUpdatedAt: null })],
      [srv({ code: 'EUR', rate: 105, rateUpdatedAt: '2026-07-23T03:00:00.000Z' })],
    );
    expect(next[0].rate).toBe('77');
    expect(next[0].manualRate).toBe(true);
    expect(next[0].rateUpdatedAt).toBeNull();
  });

  it('несохранённые правки соседних полей переживают пересев', () => {
    const next = applyServerRates(
      [
        row({
          code: 'EUR',
          symbol: 'евро-правка',
          rate: '100',
          fractionDigits: '4',
          manualRate: false,
        }),
      ],
      [srv({ code: 'EUR', symbol: '€', rate: 105, fractionDigits: 2 })],
    );
    expect(next[0]).toMatchObject({
      symbol: 'евро-правка',
      fractionDigits: '4',
      rate: '105',
    });
  });

  it('строка, добавленная владельцем и ещё не сохранённая, не исчезает и не портится', () => {
    const next = applyServerRates(
      [row({ code: 'EUR', rate: '100' }), row({ code: 'CNY', rate: '' })],
      [srv({ code: 'EUR', rate: 105 })],
    );
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ code: 'CNY', rate: '' });
  });

  it('валюта, удалённая владельцем в форме, не воскресает из снимка', () => {
    const next = applyServerRates(
      [row({ code: 'EUR', rate: '100' })],
      [srv({ code: 'EUR', rate: 105 }), srv({ code: 'USD', rate: 90 })],
    );
    expect(next.map((r) => r.code)).toEqual(['EUR']);
  });

  it('порядок строк формы сохраняется', () => {
    const next = applyServerRates(
      [row({ code: 'USD', rate: '1' }), row({ code: 'EUR', rate: '2' })],
      [srv({ code: 'EUR', rate: 105 }), srv({ code: 'USD', rate: 90 })],
    );
    expect(next.map((r) => r.code)).toEqual(['USD', 'EUR']);
    expect(next.map((r) => r.rate)).toEqual(['90', '105']);
  });

  it('код сопоставляется без учёта регистра и пробелов (владелец печатает руками)', () => {
    const next = applyServerRates(
      [row({ code: ' eur ', rate: '100' })],
      [srv({ code: 'EUR', rate: 105 })],
    );
    expect(next[0].rate).toBe('105');
    // Введённый текст кода не переписывается — это правка владельца.
    expect(next[0].code).toBe(' eur ');
  });

  it('идемпотентность: повторное наложение того же снимка ничего не меняет', () => {
    const rows = [row({ code: 'EUR', rate: '100' })];
    const server = [srv({ code: 'EUR', rate: 105, rateUpdatedAt: 'ts' })];
    const once = applyServerRates(rows, server);
    expect(applyServerRates(once, server)).toEqual(once);
  });

  it('исходный массив строк не мутируется', () => {
    const rows = [row({ code: 'EUR', rate: '100' })];
    applyServerRates(rows, [srv({ code: 'EUR', rate: 105 })]);
    expect(rows[0].rate).toBe('100');
  });

  it('пустой серверный снимок → форма остаётся как есть', () => {
    const rows = [row({ code: 'EUR', rate: '100' })];
    expect(applyServerRates(rows, [])).toEqual(rows);
  });

  it('не под конкретный магазин: логика одинакова для любого ISO-кода', () => {
    const next = applyServerRates(
      [row({ code: 'KZT', rate: '0.2' }), row({ code: 'TRY', rate: '3', manualRate: true })],
      [srv({ code: 'KZT', rate: 0.19 }), srv({ code: 'TRY', rate: 2.5 })],
    );
    expect(next.map((r) => r.rate)).toEqual(['0.19', '3']);
  });
});
