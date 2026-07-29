import { describe, it, expect } from 'vitest';

/**
 * Аудит minor №1 и №2 — сопоставление ПОЛНОЙ корзины с ответом /cart/quote.
 *
 * №1: сервер нумерует issues[].index по УРЕЗАННОМУ массиву (позиции без productId
 * отфильтрованы), а рендер идёт по ПОЛНОЙ корзине — индексы расходились, и метка
 * «нет в наличии» показывалась НЕ У ТОЙ позиции.
 * №2: суммы строк брались из localStorage, тогда как итог считал сервер; при смене
 * цены в каталоге строки не сходились с итогом без всякого объяснения.
 *
 * Импорт относительным путём: storefront — отдельное Next-приложение со своим
 * алиасом @, модуль standalone (без @/-импортов).
 */

import {
  buildApiIndexToCartIndex,
  mapIssuesToCartIndex,
  mapServerLinesToCartIndex,
  hasPriceChanged,
  type CartLineLike,
  type QuoteLineLike,
} from '../../storefront/lib/checkout-lines';

/** Позиция корзины: с productId (уедет серверу) или без (старая запись localStorage). */
const withId = (price = 100): CartLineLike => ({ productId: 'uuid', price });
const legacy = (price = 100): CartLineLike => ({ price });

const line = (unitPrice: string, lineTotal: string): QuoteLineLike => ({
  unitPrice,
  lineTotal,
});

describe('buildApiIndexToCartIndex — перевод индексов урезанного массива', () => {
  it('без «старых» позиций индексы совпадают один в один', () => {
    const map = buildApiIndexToCartIndex([withId(), withId(), withId()]);
    expect([...map.entries()]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('🔴 ДЕФЕКТ №1: «старая» позиция ПЕРВОЙ сдвигает все серверные индексы', () => {
    // Корзина: [старая, A, B] → серверу уехали [A, B].
    // Сервер скажет index=0 про A, а в корзине A стоит под индексом 1.
    const map = buildApiIndexToCartIndex([legacy(), withId(), withId()]);
    expect(map.get(0)).toBe(1);
    expect(map.get(1)).toBe(2);
  });

  it('«старая» позиция В СЕРЕДИНЕ сдвигает только то, что после неё', () => {
    const map = buildApiIndexToCartIndex([withId(), legacy(), withId()]);
    expect(map.get(0)).toBe(0);
    expect(map.get(1)).toBe(2);
  });

  it('несколько «старых» подряд', () => {
    const map = buildApiIndexToCartIndex([legacy(), legacy(), withId(), legacy(), withId()]);
    expect(map.get(0)).toBe(2);
    expect(map.get(1)).toBe(4);
    expect(map.size).toBe(2);
  });

  it('корзина только из «старых» позиций → карта пуста (серверу ничего не уехало)', () => {
    expect(buildApiIndexToCartIndex([legacy(), legacy()]).size).toBe(0);
  });

  it('пустая корзина не роняет', () => {
    expect(buildApiIndexToCartIndex([]).size).toBe(0);
  });
});

describe('mapIssuesToCartIndex — проблема попадает НА СВОЮ строку (№1)', () => {
  it('🔴 регресс-тест дефекта: проблема сервера про index=0 садится на строку 1', () => {
    const items = [legacy(), withId(), withId()];
    const map = buildApiIndexToCartIndex(items);
    const issues = mapIssuesToCartIndex([{ index: 0, code: 'out_of_stock' }], map);
    // Раньше метка вешалась на индекс 0 — на «старую» позицию, к которой сервер
    // вообще не имел отношения.
    expect(issues.get(0)).toBeUndefined();
    expect(issues.get(1)).toBe('out_of_stock');
  });

  it('несколько проблем раскладываются каждая на свою строку', () => {
    const items = [legacy(), withId(), withId(), withId()];
    const map = buildApiIndexToCartIndex(items);
    const issues = mapIssuesToCartIndex(
      [
        { index: 0, code: 'out_of_stock' },
        { index: 2, code: 'product_not_found' },
      ],
      map,
    );
    expect(issues.get(1)).toBe('out_of_stock');
    expect(issues.get(3)).toBe('product_not_found');
    expect(issues.size).toBe(2);
  });

  it('индекс вне карты (сервер отстал от корзины) ОТБРАСЫВАЕТСЯ, а не садится на чужую строку', () => {
    const map = buildApiIndexToCartIndex([withId()]);
    const issues = mapIssuesToCartIndex([{ index: 5, code: 'out_of_stock' }], map);
    expect(issues.size).toBe(0);
  });

  it('нет проблем → пустая карта', () => {
    const map = buildApiIndexToCartIndex([withId(), withId()]);
    expect(mapIssuesToCartIndex([], map).size).toBe(0);
  });
});

describe('mapServerLinesToCartIndex — серверные суммы на своих строках (№2)', () => {
  it('без проблем и без «старых» позиций строки ложатся один в один', () => {
    const items = [withId(), withId()];
    const map = buildApiIndexToCartIndex(items);
    const out = mapServerLinesToCartIndex(
      [line('100.00', '100.00'), line('200.00', '400.00')],
      [],
      2,
      map,
    );
    expect(out.get(0)?.lineTotal).toBe('100.00');
    expect(out.get(1)?.lineTotal).toBe('400.00');
  });

  it('🔴 позиция с issue ОТСУТСТВУЕТ в lines — сдвиг учитывается', () => {
    // Серверу уехали [A, B, C]; по B пришёл issue → lines = [строка A, строка C].
    const items = [withId(), withId(), withId()];
    const map = buildApiIndexToCartIndex(items);
    const out = mapServerLinesToCartIndex(
      [line('10.00', '10.00'), line('30.00', '30.00')],
      [{ index: 1 }],
      3,
      map,
    );
    expect(out.get(0)?.lineTotal).toBe('10.00');
    // Проблемной позиции серверной суммы нет вовсе.
    expect(out.get(1)).toBeUndefined();
    // А третья позиция получает ВТОРУЮ строку lines, а не третью.
    expect(out.get(2)?.lineTotal).toBe('30.00');
  });

  it('«старая» позиция + issue: оба сдвига складываются корректно', () => {
    // Корзина: [старая, A, B]; серверу уехали [A, B]; по A пришёл issue.
    const items = [legacy(), withId(), withId()];
    const map = buildApiIndexToCartIndex(items);
    const out = mapServerLinesToCartIndex([line('50.00', '50.00')], [{ index: 0 }], 2, map);
    expect(out.get(0)).toBeUndefined(); // старая позиция
    expect(out.get(1)).toBeUndefined(); // A — проблемная
    expect(out.get(2)?.lineTotal).toBe('50.00'); // B
  });

  it('пустой lines (старый ответ API) не роняет и ничего не выдумывает', () => {
    const map = buildApiIndexToCartIndex([withId(), withId()]);
    expect(mapServerLinesToCartIndex([], [], 2, map).size).toBe(0);
  });

  it('lines короче ожидаемого — лишние индексы просто без строки', () => {
    const map = buildApiIndexToCartIndex([withId(), withId()]);
    const out = mapServerLinesToCartIndex([line('1.00', '1.00')], [], 2, map);
    expect(out.get(0)?.lineTotal).toBe('1.00');
    expect(out.get(1)).toBeUndefined();
  });
});

describe('hasPriceChanged — расхождение цены корзины и каталога объясняется (№2)', () => {
  it('цены совпадают → объяснять нечего', () => {
    const items = [withId(100)];
    const server = new Map([[0, line('100.00', '100.00')]]);
    expect(hasPriceChanged(items, server)).toBe(false);
  });

  it('строка NUMERIC и число — одна сумма (без ложного срабатывания)', () => {
    const items = [withId(7500)];
    const server = new Map([[0, line('7500', '7500')]]);
    expect(hasPriceChanged(items, server)).toBe(false);
  });

  it('цена в каталоге выросла → расхождение найдено', () => {
    const items = [withId(100)];
    const server = new Map([[0, line('120.00', '120.00')]]);
    expect(hasPriceChanged(items, server)).toBe(true);
  });

  it('расхождение в копейках тоже ловится', () => {
    const items = [withId(100)];
    const server = new Map([[0, line('100.01', '100.01')]]);
    expect(hasPriceChanged(items, server)).toBe(true);
  });

  it('позиция без серверной строки не считается изменившейся', () => {
    const items = [withId(100)];
    expect(hasPriceChanged(items, new Map())).toBe(false);
  });

  it('битая цена в корзине не выдаётся за смену цены', () => {
    const items: CartLineLike[] = [{ productId: 'u', price: Number.NaN }];
    const server = new Map([[0, line('100.00', '100.00')]]);
    expect(hasPriceChanged(items, server)).toBe(false);
  });
});
