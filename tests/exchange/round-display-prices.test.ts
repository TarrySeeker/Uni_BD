import { describe, expect, it } from 'vitest';

import {
  roundDisplayPrice,
  planDisplayPriceUpdates,
  type RoundablePricePolicy,
} from '@/lib/exchange/round-display-prices';

/**
 * Округление цен показа в доп.валютах (решение владельца 29.07.2026).
 *
 * ЗАЧЕМ: цена показа считается делением рублёвой на курс, поэтому европейский
 * покупатель видел «178,51 €» и «362,61 €» — арифметический хвост вместо ценника.
 * Владелец выбрал: округлять ДО ЦЕЛОГО ЕВРО и ПЕРЕСЧИТЫВАТЬ автоматически при
 * смене курса ЦБ (иначе зафиксированная цена в € со временем разъедется с ₽).
 *
 * 🔴 ГРАНИЦА, которую нельзя размывать: `display_prices` — ТОЛЬКО показ.
 * В корзине, заказе и оплате участвует base_price в рублях (ADR-010, guard-тесты
 * payment-base-currency и display-prices-not-in-payments). Здесь считается
 * витринный ярлык, а не деньги.
 */
describe('округление цены показа', () => {
  const toWhole: RoundablePricePolicy = { mode: 'whole' };

  it('округляет до целого по правилам арифметики', () => {
    // 16000 ₽ / 89.6292 = 178.51 → 179
    expect(roundDisplayPrice(16000, 89.6292, toWhole)).toBe('179.00');
    // 999 ₽ / 89.6292 = 11.15 → 11
    expect(roundDisplayPrice(999, 89.6292, toWhole)).toBe('11.00');
    // 32500 ₽ / 89.6292 = 362.61 → 363
    expect(roundDisplayPrice(32500, 89.6292, toWhole)).toBe('363.00');
  });

  it('никогда не даёт ноль: дешёвый товар стоит минимум 1 единицу валюты', () => {
    // 30 ₽ / 89.63 = 0.33 → округление дало бы 0, а «0 €» на витрине — брак
    // (и приглашение «купить бесплатно», хотя списание идёт в рублях).
    expect(roundDisplayPrice(30, 89.6292, toWhole)).toBe('1.00');
    expect(roundDisplayPrice(1, 89.6292, toWhole)).toBe('1.00');
  });

  it('не считает цену при негодном курсе — лучше показать курсовую, чем враньё', () => {
    expect(roundDisplayPrice(16000, 0, toWhole)).toBeNull();
    expect(roundDisplayPrice(16000, -5, toWhole)).toBeNull();
    expect(roundDisplayPrice(16000, Number.NaN, toWhole)).toBeNull();
  });

  it('не считает цену для некорректной базовой цены', () => {
    expect(roundDisplayPrice(0, 89.6292, toWhole)).toBeNull();
    expect(roundDisplayPrice(-100, 89.6292, toWhole)).toBeNull();
  });
});

describe('план обновления цен показа', () => {
  const rates = { EUR: 89.6292, USD: 78.698 };

  it('считает цены по всем валютам показа сразу', () => {
    const plan = planDisplayPriceUpdates(
      [{ id: 'p1', basePrice: '16000.00', displayPrices: {} }],
      rates,
      { mode: 'whole' },
    );

    expect(plan).toEqual([
      { id: 'p1', displayPrices: { EUR: '179.00', USD: '203.00' } },
    ]);
  });

  it('пропускает товар, у которого цены уже верные — не трогаем БД зря', () => {
    // Идемпотентность: повторный прогон на неизменном курсе не пишет ничего.
    const plan = planDisplayPriceUpdates(
      [{ id: 'p1', basePrice: '16000.00', displayPrices: { EUR: '179.00', USD: '203.00' } }],
      rates,
      { mode: 'whole' },
    );

    expect(plan).toEqual([]);
  });

  it('пересчитывает, когда курс ушёл — ради этого владелец и выбрал автоматику', () => {
    const plan = planDisplayPriceUpdates(
      [{ id: 'p1', basePrice: '16000.00', displayPrices: { EUR: '179.00' } }],
      { EUR: 100 }, // курс вырос: 16000/100 = 160
      { mode: 'whole' },
    );

    expect(plan).toEqual([{ id: 'p1', displayPrices: { EUR: '160.00' } }]);
  });

  it('товар с негодной базовой ценой не попадает в план и не ломает остальные', () => {
    const plan = planDisplayPriceUpdates(
      [
        { id: 'bad', basePrice: '0.00', displayPrices: {} },
        { id: 'ok', basePrice: '999.00', displayPrices: {} },
      ],
      { EUR: 89.6292 },
      { mode: 'whole' },
    );

    expect(plan).toEqual([{ id: 'ok', displayPrices: { EUR: '11.00' } }]);
  });

  it('пустой список валют показа = нечего считать (магазин одновалютный)', () => {
    const plan = planDisplayPriceUpdates(
      [{ id: 'p1', basePrice: '16000.00', displayPrices: {} }],
      {},
      { mode: 'whole' },
    );

    expect(plan).toEqual([]);
  });

  it('валюта с испорченным курсом выпадает, остальные считаются', () => {
    // Устойчивость: битый курс одной валюты не должен лишать витрину всех цен.
    const plan = planDisplayPriceUpdates(
      [{ id: 'p1', basePrice: '16000.00', displayPrices: {} }],
      { EUR: 89.6292, USD: 0 },
      { mode: 'whole' },
    );

    expect(plan).toEqual([{ id: 'p1', displayPrices: { EUR: '179.00' } }]);
  });

  it('уже проставленную цену валюты с испорченным курсом НЕ стираем', () => {
    // Прежняя цена лучше пустоты: витрина откатится на курсовую только если
    // мы её сотрём. Испорченный курс — временная беда, ярлык терять незачем.
    const plan = planDisplayPriceUpdates(
      [{ id: 'p1', basePrice: '16000.00', displayPrices: { USD: '203.00' } }],
      { USD: 0 },
      { mode: 'whole' },
    );

    expect(plan).toEqual([]);
  });
});
