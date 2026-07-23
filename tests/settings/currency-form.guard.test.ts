import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENCY_CATALOG, availableToAdd, lookupCurrency } from '@/lib/exchange/catalog';

/**
 * GUARD по разметке CurrencyUnitsForm.tsx (тестов React-компонентов в проекте нет:
 * vitest environment 'node'). Сторожим СУТЬ формы валют — нужный вызов ЕСТЬ и
 * антипаттерн ЗАПРЕЩЁН:
 *   • пер-валютный признак «курс задан вручную» редактируется у КАЖДОЙ строки;
 *   • добавление валюты идёт из справочника платформы, а не хардкодом EUR;
 *   • есть ручной запуск обновления курсов (возврат валюты на автокурс без
 *     ожидания ночного крона).
 * До этого пакета файл формы не читал НИ ОДИН тест.
 */

const FORM = resolve(
  __dirname,
  '../../app/admin/(panel)/settings/_components/CurrencyUnitsForm.tsx',
);
const source = readFileSync(FORM, 'utf8');

describe('CurrencyUnitsForm — пер-валютный ручной курс', () => {
  it('у строки валюты есть чекбокс manualRate', () => {
    expect(source).toContain('setRow(i, { manualRate: e.target.checked })');
    expect(source).toContain('Курс задан вручную');
  });

  it('признак уходит в действие сохранения (иначе галочка ничего не делает)', () => {
    expect(source).toContain('manualRate: r.manualRate');
  });

  it('пер-валютная метка обновления показывается владельцу', () => {
    expect(source).toContain('r.rateUpdatedAt');
  });
});

describe('CurrencyUnitsForm — добавление валюты без хардкода', () => {
  it('валюта берётся из справочника платформы', () => {
    expect(source).toContain("from '@/lib/exchange/catalog'");
    expect(source).toContain('availableToAdd');
    expect(source).toContain('CURRENCY_CATALOG.find');
  });

  it('АНТИПАТТЕРН: кнопка добавления НЕ подставляет конкретную валюту жёстко', () => {
    // Раньше addRow создавала строку { code: 'EUR', symbol: '€', ... } — второй
    // хардкод под конкретный магазин. Никакой ISO-код не должен появляться в коде
    // формы как значение новой строки.
    expect(source).not.toMatch(/code:\s*'(EUR|USD|RUB)'/);
  });
});

describe('CurrencyUnitsForm — ручное обновление курсов', () => {
  it('форма зовёт действие обновления курсов', () => {
    expect(source).toContain('refreshExchangeRatesAction');
    expect(source).toContain('Обновить курсы с ЦБ сейчас');
  });

  it('АНТИПАТТЕРН: обновление не дёргает cron-роут напрямую с секретом', () => {
    expect(source).not.toContain('/api/cron/exchange');
    expect(source).not.toContain('CRON_SECRET');
  });
});

describe('CurrencyUnitsForm — форма показывает АКТУАЛЬНЫЕ курсы после обновления', () => {
  /**
   * router.refresh() перерисовывает серверную страницу, но состояние клиентского
   * компонента React сохраняет. Форма обязана ПЕРЕСЕЯТЬ курсы из новых пропсов,
   * иначе владелец видит старые значения (кнопка выглядит сломанной), а следующее
   * «Сохранить» записывает их обратно, откатывая только что полученные свежие.
   */
  it('строки засеваются общей функцией, а не «замороженным» инлайном пропсов', () => {
    expect(source).toContain("from './currency-form-state'");
    expect(source).toContain('rowsFromServer(exchange.displayCurrencies)');
  });

  it('АНТИПАТТЕРН: useState не засевается пропсами напрямую (без механизма пересева)', () => {
    // Было: useState<DisplayCurrencyRow[]>(exchange.displayCurrencies.map(...)) —
    // единоразовый снимок, который больше никогда не обновлялся.
    expect(source).not.toMatch(/useState\s*(<[^>]*>)?\s*\(\s*exchange\.displayCurrencies/);
    expect(source).not.toMatch(/exchange\.displayCurrencies\.map\s*\(/);
  });

  it('пересев завязан на сравнение серверного снимка курсов', () => {
    expect(source).toContain('ratesSignature(exchange.displayCurrencies)');
    expect(source).toMatch(/applyServerRates\(\s*prev\s*,\s*exchange\.displayCurrencies\s*\)/);
    // Сравнение подписи обязано быть УСЛОВИЕМ: безусловный пересев затирал бы
    // несохранённые правки владельца при любой перерисовке.
    expect(source).toMatch(/if\s*\([^)]*Signature\s*!==\s*[^)]*Signature\s*\)/);
  });

  it('пересев взводится успешным обновлением курсов и только им', () => {
    // Взвод стоит в обработчике кнопки, вплотную перед router.refresh().
    expect(source).toMatch(/setAwaitingServerRates\(true\)[\s\S]{0,120}router\.refresh\(\)/);
    // Взводится ровно один раз (в ветке успеха ручного обновления).
    expect(source.match(/setAwaitingServerRates\(true\)/g)).toHaveLength(1);
    // Сохранение формы пересев не взводит (там серверные данные = только что
    // отправленные) — иначе флаг «протекал» бы на чужие перерисовки.
    const save = source.slice(source.indexOf('async function save()'));
    expect(save).not.toContain('setAwaitingServerRates(true)');
  });

  it('АНТИПАТТЕРН: форма не перемонтируется целиком (key) — это стёрло бы всю правку', () => {
    expect(source).not.toMatch(/key=\{\s*(exchange|serverSignature|ratesSignature)/);
  });
});

describe('справочник валют платформы', () => {
  it('USD есть с символом $ и 2 знаками (ТЗ п.10 «добавить доллар»)', () => {
    expect(lookupCurrency('usd')).toEqual({
      code: 'USD',
      symbol: '$',
      fractionDigits: 2,
      label: 'Доллар США',
    });
  });

  it('не под конкретный магазин: валют много, коды уникальны и ISO-формата', () => {
    expect(CURRENCY_CATALOG.length).toBeGreaterThan(5);
    const codes = CURRENCY_CATALOG.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{3}$/);
  });

  it('уже добавленные и базовая валюта из списка выбывают', () => {
    const left = availableToAdd('RUB', ['EUR']);
    const codes = left.map((c) => c.code);
    expect(codes).not.toContain('RUB');
    expect(codes).not.toContain('EUR');
    expect(codes).toContain('USD');
  });
});
